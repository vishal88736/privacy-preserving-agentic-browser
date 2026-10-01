/**
 * Privacy-Preserving Agentic Browser - Content Script
 * Self-contained for Chrome Manifest V3 isolated world execution.
 * Handles DOM perception, visual overlays, physical action execution, and page stability.
 */

(() => {
  // The logger shim (content/log-forwarder.js) is registered ahead of this file
  // in the manifest, so it is always defined in the isolated world. The fallback
  // covers a non-browser evaluation (the unit-test harness may run this file on
  // its own) and must never itself throw: a throw here would abort the whole
  // injection and leave the tab permanently unresponsive.
  const log = globalThis.__privAgentLog || {
    debug: () => {},
    info: (...parts) => console.log(...parts),
    warn: (...parts) => console.warn(...parts),
    error: (...parts) => console.error(...parts),
    exception: (scope, message, error) => console.error(`[${scope}] ${message}:`, error)
  };

  // Attributes whose mutation can change what an element IS or what it is
  // worth. Anything outside this list (hover classes, framework data-*
  // bookkeeping, SVG churn) cannot affect extraction, so it never needs to
  // wake the page-stability observer.
  const OBSERVED_ATTRIBUTES = Object.freeze([
    'value', 'checked', 'disabled', 'readonly', 'required', 'type', 'name',
    'href', 'placeholder', 'aria-label', 'aria-labelledby', 'aria-hidden',
    'aria-expanded', 'aria-selected', 'aria-disabled', 'role', 'hidden',
    'style', 'class'
  ]);
  // Coalesce mutation bursts into one revision bump. The revision is a
  // monotonic counter, so a single bump per burst is equivalent for every
  // staleness comparison that reads it.
  const MUTATION_COALESCE_MS = 50;

  // Prevent duplicate injections, but recover after an extension
  // reload/update: this flag persists in the isolated world while the
  // previous injection's runtime is invalidated (its listeners stop
  // working). Probe the runtime and re-initialize when it is dead —
  // otherwise the auto-injection retry fails permanently.
  let previousInjectionValid = false;
  if (window.__PRIVACY_AGENT_CONTENT_INITIALIZED__) {
    try {
      previousInjectionValid = Boolean(chrome.runtime?.id);
    } catch {
      previousInjectionValid = false;
    }
  }
  if (previousInjectionValid) return;

  log.info('PrivacyAgent', 'Content script initialized.');

  // Time allowed for scrollIntoView + layout shift to settle before the action
  // target is re-resolved. Re-resolving after the scroll (rather than before)
  // is what keeps the highlighted element and the acted-on element identical.
  const SCROLL_SETTLE_MS = 150;

  // Message Types
  // Set only once the listener is actually registered. Setting this first meant
  // any throw during the rest of evaluation left the flag true with no listener
  // behind it, and every later injection — including both recovery paths —
  // bailed out at the top, leaving the tab permanently unresponsive until a
  // manual reload.
  const markInitialized = () => { window.__PRIVACY_AGENT_CONTENT_INITIALIZED__ = true; };

  const MessageType = {
    EXTRACT_DOM: 'EXTRACT_DOM',
    EXECUTE_ACTION: 'EXECUTE_ACTION',
    CLEAR_OVERLAYS: 'CLEAR_OVERLAYS',
    CHECK_PAGE_STABILITY: 'CHECK_PAGE_STABILITY'
  };

  const OBSERVATION_BOUND_ACTIONS = new Set([
    'CLICK', 'TYPE', 'SELECT', 'CHECK', 'UNCHECK', 'HOVER', 'UPLOAD', 'SUBMIT',
    'FILL_FORM_PLAN', 'SCROLL', 'PRESS_KEY', 'EXTRACT'
  ]);

  // 1. Element Registry
  class ElementRegistry {
    constructor() {
      this.idToElement = new Map();
      this.elementToId = new WeakMap();
      this.counter = 1;
      this.snapshotId = null;
    }

    clear() {
      this.idToElement.clear();
      // WeakMap has no .clear(): allocate a fresh one, otherwise re-extracted
      // identical nodes resolve to stale ids that are absent from idToElement
      // and every lookup after the first extraction returns null.
      this.elementToId = new WeakMap();
      this.counter = 1;
      this.snapshotId = null;
    }

    register(element) {
      if (this.elementToId.has(element)) {
        return this.elementToId.get(element);
      }
      const id = `el_${this.counter++}`;
      this.idToElement.set(id, element);
      this.elementToId.set(element, id);
      return id;
    }

    getElement(id) {
      return this.idToElement.get(id) || null;
    }

    getId(element) {
      return element && this.elementToId.has(element) ? this.elementToId.get(element) : null;
    }
  }

  const registry = new ElementRegistry();

  // Auto-generated control identifiers carry no meaning ("entry.2005620554",
  // "question-12", "field_3"). Returning one as the accessible label makes
  // every downstream classifier match the wrong thing — or nothing at all —
  // so such names are skipped and labelling falls through to context. This is
  // a generic opaque-id rule, not a per-site exception.
  // Strings a control exposes in place of a real name: browser format hints
  // ("mm/dd/yyyy", "dd/mm/yyyy", "yyyy-mm-dd"), generic prompts ("Your
  // answer", "Type here"), and bare data-type words ("Date", "Email"). None of
  // these identify WHICH value the field wants, so label resolution must look
  // for the question instead of returning them as the field's name.
  /**
   * First informative line of a question block.
   *
   * Once a user has answered a field, its container text becomes the question
   * AND the answer on separate lines ("Name" / "vishal"). A heading/legend
   * already excludes the answer; container text does not, so the second line is
   * dropped here rather than being carried into the field name and from there
   * into an outbound payload.
   */
  function firstMeaningfulLine(text) {
    const lines = String(text || '').split('\n').map((line) => line.replace(/\s+/g, ' ').trim());
    for (const line of lines) {
      if (!line || isUninformativeLabel(line)) continue;
      // A lone format hint or "Your answer" means the first line was chrome.
      if (/^(?:mm\/dd\/yyyy|dd\/mm\/yyyy|yyyy-mm-dd)$/i.test(line)) continue;
      return line.slice(0, 160);
    }
    return null;
  }

  function isUninformativeLabel(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value) return true;
    if (/^(?:mm\/dd\/yyyy|dd\/mm\/yyyy|yyyy-mm-dd|yyyy\/mm\/dd|dd-mm-yyyy|mm-dd-yyyy|mm\/dd\/yy|dd\/mm\/yy)$/i.test(value)) return true;
    if (/^(?:your\s+answer|type\s+here|enter\s+(?:your\s+)?(?:answer|value|text)|select\s+an?\s+option|choose\s+an?\s+option|option|search|filter|query|type)$/i.test(value)) return true;
    // A bare HTML input/textarea type word.
    if (/^(?:text|date|time|datetime-local|month|week|email|tel|number|password|url|search|file|color|range)$/i.test(value)) return true;
    return false;
  }

  function isOpaqueControlName(name) {
    const value = String(name || '').trim();
    if (!value) return true;
    if (/^\d+$/.test(value)) return true;
    return /^(?:entry|question|field|input|control|answer|item|option|choice|text|response)(?:[._\-\s]*\d+)+$/i.test(value);
  }

  // Escape ids for use inside attribute selectors: element ids may contain
  // colons, dots, or brackets that would otherwise break (or worse, inject
  // into) the selector. CSS.escape is not available in all runtimes (Node
  // test environments), so fall back to a conservative escape.
  function escapeIdForSelector(id) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(id));
    return String(id).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // ── Vault document payloads ───────────────────────────────────────────────
  //
  // The only accepted shape for a stored document. The marker must be present:
  // it is set by the background resolver and required again here, so a page, a
  // model, or any other value that happens to be an object with a `name` and
  // `data` field cannot be mistaken for a document the user stored.
  const VAULT_DOCUMENT_MARKER = '__vaultDocument';
  const DOCUMENT_NAME_TOKEN = /^LOCAL_DOCUMENT_[A-Z0-9_]{1,48}$/;

  function isVaultDocumentPayload(value) {
    return Boolean(value) && typeof value === 'object' &&
      value[VAULT_DOCUMENT_MARKER] === true &&
      DOCUMENT_NAME_TOKEN.test(String(value.name || '')) &&
      typeof value.data === 'string';
  }

  /** base64 (or a byte array) -> Uint8Array. Returns null on anything else. */
  function decodeVaultDocumentBytes(doc) {
    try {
      if (typeof atob === 'function' && /^[A-Za-z0-9+/]*={0,2}$/.test(doc.data)) {
        const binary = atob(doc.data);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
      }
      if (Array.isArray(doc.bytes)) return new Uint8Array(doc.bytes);
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Does this file satisfy a page-declared `accept` list?
   * An absent or empty attribute means "no declared constraint".
   */
  function matchesAcceptAttribute(accept, fileName, mimeType) {
    const extension = String(fileName).includes('.')
      ? String(fileName).slice(String(fileName).lastIndexOf('.') + 1).toLowerCase()
      : '';
    return String(accept).split(',').some((raw) => {
      const rule = raw.trim().toLowerCase();
      if (!rule) return false;
      if (rule === '*/*' || rule === '*') return true;
      if (rule.startsWith('.')) return Boolean(extension) && extension === rule.slice(1);
      if (rule.endsWith('/*')) return String(mimeType).toLowerCase().startsWith(rule.slice(0, -1));
      return rule === String(mimeType).toLowerCase();
    });
  }

  // 2. DOM Extractor — interactive controls PLUS page evidence (cards, prices, headings, text)
  class DOMExtractor {
    // Per-extraction caches, keyed by registry.snapshotId. A new snapshot id
    // means a new extraction, so the DOM may have changed and these are stale.
    _shadowRootsCache = null;
    _shadowRootsCacheKey = null;
    _headingIndexCache = null;
    _headingIndexCacheKey = null;

    getAccessibleLabel(element) {
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        // W3C aria-labelledby is a SPACE-SEPARATED LIST of ids whose texts
        // join in order (question title + hint, on Google Forms and similar
        // ARIA forms). getElementById on the whole string returns null, which
        // silently drops every label on such pages — so resolve each id.
        const parts = [];
        for (const id of String(labelledBy).split(/\s+/).filter(Boolean)) {
          let labelEl = null;
          try {
            labelEl = document.getElementById(id);
          } catch {
            labelEl = null;
          }
          const text = labelEl ? this.getVisiblePageText(labelEl) : '';
          if (text) parts.push(text);
        }
        if (parts.length) return parts.join(' ').slice(0, 160);
      }

      const ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel && !isUninformativeLabel(ariaLabel)) return ariaLabel.trim();

      if (element.id) {
        const label = document.querySelector(`label[for="${escapeIdForSelector(element.id)}"]`);
        const labelText = label ? this.getVisiblePageText(label) : '';
        if (labelText && !isUninformativeLabel(labelText)) return labelText.trim();
      }

      const parentLabel = element.closest('label');
      const parentLabelText = parentLabel ? this.getVisiblePageText(parentLabel) : '';
      if (parentLabelText && !isUninformativeLabel(parentLabelText)) {
        return parentLabelText.trim();
      }

      // A widget that only exposes a format hint ("mm/dd/yyyy") or a generic
      // prompt ("Your answer") carries no field identity. Before settling for
      // those, look for the question the control is part of — the heading/legend
      // or list-item text above it. This is generic ARIA/HTML semantics
      // (heading, legend, listitem, labelled section), not a per-site rule.
      const question = this.getQuestionLabel(element);
      if (question) return question;

      if (element.placeholder) return element.placeholder.trim();
      if (element.title) return element.title.trim();
      if (element.name && !isOpaqueControlName(element.name)) return element.name.trim();

      if (element.innerText && element.innerText.trim()) {
        return element.innerText.trim().slice(0, 80);
      }

      return '';
    }

    /**
     * Find the question a control answers, using only standard structure:
     * an enclosing fieldset legend, an ARIA-labelled section, a list item, or
     * the nearest preceding heading. Returns null when nothing identifies it,
     * so callers keep their existing fallbacks.
     */
    getQuestionLabel(element) {
      const section = element.closest('fieldset, [role="group"], [role="radiogroup"], [role="listitem"], section, article, li');
      if (section) {
        const legend = section.querySelector?.('legend, [role="heading"], h1, h2, h3, h4, h5, h6');
        const text = legend?.innerText?.replace(/\s+/g, ' ').trim();
        if (text && !isUninformativeLabel(text)) return text.slice(0, 160);
        // A list item / section whose own text is short enough to be a caption
        // rather than a paragraph. Only its FIRST line is taken: a question
        // block's innerText is "Name\nvishal" once the user has answered it, and
        // the typed value must never travel in the field's name. Raw innerText
        // (not the whitespace-collapsed page text) is required here so the line
        // break that separates question from answer is still visible.
        const own = firstMeaningfulLine(section?.innerText);
        if (own && !isUninformativeLabel(own)) return own;
      }

      // Nearest preceding heading (covers forms that wrap each question in a plain
      // <div> with no ARIA role at all). Reads the per-extraction heading index
      // instead of re-querying every heading and re-reading its rect per
      // candidate, which forced a synchronous layout per heading per element.
      // Document order is preserved and the first qualifying heading wins, so
      // this is behaviourally identical to the previous .find().
      let heading = null;
      try {
        const targetTop = element.getBoundingClientRect().top + 1;
        for (const entry of this._headingIndex()) {
          if (entry.top <= targetTop) { heading = entry.node; break; }
        }
      } catch {}
      const headingText = heading?.innerText?.replace(/\s+/g, ' ').trim();
      if (headingText && !isUninformativeLabel(headingText)) return firstMeaningfulLine(headingText) || headingText.slice(0, 160);
      return null;
    }

    isElementVisible(element, rect) {
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      return rect.top < window.innerHeight && rect.bottom > 0 &&
             rect.left < window.innerWidth && rect.right > 0;
    }

    /**
     * Rendered (has a box, not hidden) but possibly outside the viewport.
     *
     * `isElementVisible` answers "is this on screen right now", which is the
     * right question for screenshots, overlays and media state. It is the
     * WRONG question for form fields: on a long form every field below the
     * fold is off-screen, so viewport-only extraction meant the agent could
     * only ever see the first screenful — it asked the user for values it
     * already had, and could not fill the rest of the form. A control only
     * needs to exist and be visible per CSS to be typed into, because the
     * executor scrolls it into view before writing.
     */
    isElementRendered(element, rect) {
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      try {
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
      } catch { /* keep the box check as the floor */ }
      if (element.checkVisibility) {
        try {
          if (typeof element.checkVisibility === 'function' && element.checkVisibility({
            checkOpacity: true, checkVisibilityCSS: true
          }) === false) return false;
        } catch { /* older engines: fall through to the rect check */ }
      }
      return true;
    }

    getContextText(node) {
      // A form container often contains the user's previous answers along
      // with its question text. Field labels are already resolved separately;
      // exporting the whole form as nearby context can therefore duplicate
      // entered values into a second, less carefully classified text field.
      if (/^(?:input|select|textarea)$/i.test(String(node.tagName || '')) ||
          ['textbox', 'checkbox', 'radio', 'combobox'].includes(String(node.getAttribute?.('role') || '').toLowerCase()) ||
          node.isContentEditable) return '';
      const container = node.closest('article, li, tr, form, fieldset, [role="listitem"], [class*="card"], [class*="product"], [class*="result"], [class*="item"], [class*="flight"], [class*="listing"], [data-product], [data-asin]') || node.parentElement;
      if (!container) return '';
      return String(container.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    }

    getVisiblePageText(root) {
      let text = String(root?.innerText || '').replace(/\s+/g, ' ').trim();
      if (!text || !root) return text;
      // contenteditable and ARIA textboxes render their current value as page
      // text, unlike native inputs. Remove those live values from the generic
      // page excerpt; their dedicated field values still pass through the
      // field-aware sanitizer when needed for planning.
      const editables = this.queryAllDeep('[contenteditable]:not([contenteditable="false"]), [role="textbox"]', root);
      for (const element of editables) {
        const value = element.isContentEditable
          ? String(element.textContent || '').replace(/\s+/g, ' ').trim()
          : String(element.innerText || '').replace(/\s+/g, ' ').trim();
        if (value) text = text.split(value).join('[FORM_FIELD]');
      }
      return text.slice(0, 4000);
    }

    parsePrice(text) {
      if (!text) return null;
      const m = String(text).match(/(?:₹|Rs\.?\s*|INR\s*|USD\s*|\$|€|£)\s*([\d,]+(?:\.\d{1,2})?)/i);
      if (!m) return null;
      const n = Number(m[1].replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }

    bboxOf(rect) {
      return [
        Math.round(rect.left),
        Math.round(rect.top),
        Math.round(rect.width),
        Math.round(rect.height)
      ];
    }

    containsBBox(outer, inner) {
      return inner[0] >= outer[0] - 6 &&
        inner[1] >= outer[1] - 6 &&
        inner[0] + inner[2] <= outer[0] + outer[2] + 6 &&
        inner[1] + inner[3] <= outer[1] + outer[3] + 6;
    }

    /**
     * Shadow roots reachable from the document, discovered once per extraction.
     *
     * queryAllDeep used to run `root.querySelectorAll('*')` on EVERY call just to
     * find shadow hosts, and getQuestionLabel calls it once per interactive
     * element. With MAX_ELEMENTS=120 that was up to 120 full-document walks per
     * extraction -- on a page with thousands of elements, millions of NodeList
     * entries materialised, which is what made heavy pages stall the main thread.
     *
     * Cached against the registry snapshot id, so a new extraction (or any
     * mutation that invalidates it) re-discovers. Callers that pass an explicit
     * non-document root still get a fresh walk of that root.
     */
    _shadowRootsFor(root) {
      const isDocumentRoot = !root || root === document;
      if (!isDocumentRoot) return this._walkShadowRoots(root);

      if (this._shadowRootsCache && this._shadowRootsCacheKey === registry.snapshotId) {
        return this._shadowRootsCache;
      }
      const roots = this._walkShadowRoots(document);
      this._shadowRootsCache = roots;
      this._shadowRootsCacheKey = registry.snapshotId;
      return roots;
    }

    _walkShadowRoots(root) {
      const roots = [];
      if (!root || !root.querySelectorAll) return roots;
      try {
        const allElements = root.querySelectorAll('*');
        for (let i = 0; i < allElements.length; i++) {
          const shadow = allElements[i]?.shadowRoot;
          if (shadow) roots.push(shadow);
        }
      } catch {}
      return roots;
    }

    /**
     * Recursively queries elements piercing open Shadow DOM roots.
     */
    queryAllDeep(selector, root = (typeof document !== 'undefined' ? document : null)) {
      if (!root || !root.querySelectorAll) return [];
      let matches = [];
      try {
        matches = Array.from(root.querySelectorAll(selector));
      } catch {
        matches = [];
      }

      for (const shadowRoot of this._shadowRootsFor(root)) {
        matches = matches.concat(this.queryAllDeep(selector, shadowRoot));
      }

      return matches;
    }

    /**
     * Document-order heading list with cached rects, for nearest-preceding lookup.
     *
     * Also cached per extraction: previously each getQuestionLabel call re-queried
     * every heading AND re-read getBoundingClientRect() on each one, forcing a
     * synchronous layout per read while the page's style was dirty.
     */
    _headingIndex() {
      if (this._headingIndexCache && this._headingIndexCacheKey === registry.snapshotId) {
        return this._headingIndexCache;
      }
      const index = [];
      for (const node of this.queryAllDeep('h1, h2, h3, h4, h5, h6, legend, [role="heading"]')) {
        let rect = null;
        try { rect = node.getBoundingClientRect(); } catch { continue; }
        index.push({ node, top: rect.top });
      }
      this._headingIndexCache = index;
      this._headingIndexCacheKey = registry.snapshotId;
      return index;
    }

    extractHeadings() {
      const out = [];
      for (const h of this.queryAllDeep('h1, h2, h3, [role="heading"]')) {
        const rect = h.getBoundingClientRect();
        if (!this.isElementVisible(h, rect)) continue;
        const text = (h.innerText || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        out.push({ tag: h.tagName.toLowerCase(), text: text.slice(0, 160), bbox: this.bboxOf(rect) });
        if (out.length >= 12) break;
      }
      return out;
    }

    extractResultItems(interactive) {
      const selectors = '[data-asin], [data-product-id], [data-sku], [data-product], .s-result-item, .product-card, .product, .flight-card, .search-result, .result-item, .listing-card, .item-card, article, [role="listitem"]';
      const cards = [];
      const seen = new Set();
      let nodes = [];
      try { nodes = this.queryAllDeep(selectors); } catch { nodes = []; }

      for (const node of nodes) {
        if (seen.has(node) || node.closest('nav, header, footer, [role="navigation"]')) continue;
        const rect = node.getBoundingClientRect();
        if (!this.isElementVisible(node, rect) || rect.height < 40 || rect.width < 80) continue;
        seen.add(node);
        cards.push({ node, bbox: this.bboxOf(rect) });
        if (cards.length >= 24) break;
      }

      const items = [];
      for (let i = 0; i < cards.length; i++) {
        const { node, bbox } = cards[i];
        const text = String(node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 360);
        if (text.length < 8) continue;
        const price_value = this.parsePrice(text);
        const priceMatch = text.match(/(?:₹|Rs\.?\s*|INR\s*|\$|€|£)\s*[\d,]+(?:\.\d{1,2})?/i);
        const heading = (node.querySelector('h1, h2, h3, h4, a, [class*="title"], [class*="name"]')?.innerText || '')
          .replace(/\s+/g, ' ').trim().slice(0, 140);
        const nested = interactive.filter((el) => el.bbox && this.containsBBox(bbox, el.bbox));
        const primary = nested.find((el) => el.tag === 'a' || el.tag === 'button' || el.role === 'button') || nested[0] || null;
        items.push({
          id: `item_${i + 1}`,
          title: heading || text.slice(0, 80),
          text,
          price_text: priceMatch ? priceMatch[0] : null,
          price_value,
          primary_action_id: primary?.id || null,
          nested_element_ids: nested.map((el) => el.id).slice(0, 8),
          bbox
        });
      }
      return items;
    }

    extractPageElements() {
      registry.clear();
      const snapshotId = globalThis.crypto?.randomUUID?.() ||
        `obs_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      registry.snapshotId = snapshotId;
      const formGroupIds = new WeakMap();
      let nextFormGroup = 1;
      const radioGroupIds = new WeakMap();
      const nativeRadioNamesByOwner = new WeakMap();
      let nextRadioGroup = 1;
      const getFormGroupId = (form) => {
        if (!form) return null;
        if (!formGroupIds.has(form)) formGroupIds.set(form, `form_${nextFormGroup++}`);
        return formGroupIds.get(form);
      };
      const getRadioGroupId = (node) => {
        const role = String(node.getAttribute?.('role') || '').toLowerCase();
        if (node.type === 'radio' && node.name) {
          const owner = node.form || node.closest?.('form') || document.body;
          if (owner) {
            let byName = nativeRadioNamesByOwner.get(owner);
            if (!byName) {
              byName = new Map();
              nativeRadioNamesByOwner.set(owner, byName);
            }
            if (!byName.has(node.name)) byName.set(node.name, `radio_${nextRadioGroup++}`);
            return byName.get(node.name);
          }
        }
        if (role === 'radio') {
          const group = node.closest?.('[role="radiogroup"]');
          if (!group) return null;
          if (!radioGroupIds.has(group)) radioGroupIds.set(group, `radio_${nextRadioGroup++}`);
          return radioGroupIds.get(group);
        }
        return null;
      };
      // Prioritized passes: form controls first, then buttons, then links —
      // so form fields are never dropped on complex pages even at the cap.
      // DOM order within each pass is preserved.
      const passes = [
        'input, select, textarea, [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [contenteditable]:not([contenteditable="false"])',
        'button, [role="button"], [role="option"]',
        'a, [role="link"], [tabindex]:not([tabindex="-1"])'
      ];
      const seen = new Set();
      const rawNodes = [];
      for (const selector of passes) {
        for (const node of this.queryAllDeep(selector)) {
          if (!seen.has(node)) {
            seen.add(node);
            rawNodes.push(node);
          }
        }
      }

      const MAX_ELEMENTS = 120;
      const extracted = [];
      let elementLimitReached = false;
      // Bound the WORK, not just the output. A `continue` for a non-rendered
      // node never increments `extracted`, so on a page whose third pass
      // matches thousands of mostly-hidden links the loop ran to completion,
      // doing two getComputedStyle reads and a layout read per node. Cap the
      // candidates examined so a pathological page degrades instead of hanging.
      const MAX_CANDIDATES_EXAMINED = MAX_ELEMENTS * 12;
      let candidatesExamined = 0;

      for (const node of rawNodes) {
        if (candidatesExamined >= MAX_CANDIDATES_EXAMINED) {
          elementLimitReached = true;
          break;
        }
        candidatesExamined++;
        const rect = node.getBoundingClientRect();
        const isVisible = this.isElementVisible(node, rect);
        // Off-screen but rendered controls are still real, typeable fields on
        // a long form; the executor scrolls them into view before writing.
        // Only a control that is genuinely not rendered (or has no box) is
        // dropped, plus hidden file inputs which are styled away everywhere.
        const isRendered = this.isElementRendered(node, rect);

        if (!isRendered && node.type !== 'file') continue;
        if (extracted.length >= MAX_ELEMENTS) {
          elementLimitReached = true;
          break;
        }

        const id = registry.register(node);
        const tag = node.tagName.toLowerCase();
        const role = String(node.getAttribute('role') || '').toLowerCase();
        const formElement = node.form || node.closest?.('form') || null;
        const isContentEditable = Boolean(node.isContentEditable);
        const isFormControl = /^(?:input|select|textarea)$/i.test(tag) ||
          ['textbox', 'checkbox', 'radio', 'combobox'].includes(role) || isContentEditable;
        const controlValue = node.type === 'file' ? '' : (typeof node.value === 'string'
          ? node.value
          : (isContentEditable ? String(node.textContent || '') : ''));
        const label = this.getAccessibleLabel(node);
        const context = this.getContextText(node);
        const price_value = this.parsePrice(`${label} ${context}`);
        const describedBy = String(node.getAttribute('aria-describedby') || '').split(/\s+/)
          .map((describedById) => {
            const described = document.getElementById(describedById);
            return described ? this.getVisiblePageText(described) : '';
          })
          .filter(Boolean).join(' ').slice(0, 500);
        const legend = node.closest('fieldset')?.querySelector('legend');
        const fieldsetLegend = legend ? this.getVisiblePageText(legend).slice(0, 240) : '';

        let options = undefined;
        if (tag === 'select') {
          options = Array.from(node.options || []).map(option => ({
            text: String(option.text || '').trim(),
            value: String(option.value || '').trim(),
            selected: Boolean(option.selected)
          }));
        } else if (node.type === 'radio' && node.name) {
          options = Array.from(document.querySelectorAll('input[type="radio"]'))
            .filter(radio => radio.name === node.name && radio.form === node.form)
            .map(radio => ({
              text: this.getAccessibleLabel(radio),
              value: String(radio.value || ''),
              checked: Boolean(radio.checked)
            }));
        }

        extracted.push({
          id,
          _node: node,
          tag,
          type: node.type || '',
          name: node.name || '',
          label,
          accessible_name: label,
          // A custom textbox may expose its current answer as innerText. The
          // value goes through the value sanitizer below; copying it into the
          // generic page-text channel would bypass field sensitivity checks.
          text: isFormControl ? '' : String(node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 180),
          title: String(node.title || '').slice(0, 180),
          placeholder: node.placeholder || '',
          // File input values contain a browser-generated fake path and the
          // user's local filename. Neither is needed for planning; the
          // privacy-safe has_value bit below is enough to report attachment.
          value: controlValue,
          // Privacy-safe filled bit (boolean only — never a value or length).
          // The sanitizer redacts values to '[REDACTED]', which downstream
          // filled-checks treat as EMPTY, so filled sensitive fields otherwise
          // look unfilled forever and the agent re-types them in a loop.
          has_value: node.type === 'file'
            ? Boolean(node.files?.length)
            : role === 'checkbox' || role === 'radio'
            ? node.getAttribute('aria-checked') === 'true'
            : tag === 'select'
            ? Boolean(node.selectedIndex >= 0 &&
                String(node.options?.[node.selectedIndex]?.value || '').trim())
            : (node.type === 'checkbox' || node.type === 'radio')
              ? Boolean(node.checked)
              : controlValue.trim().length > 0,
          autocomplete: node.autocomplete || '',
          ariaLabel: node.getAttribute('aria-label') || '',
          ariaDescribedBy: describedBy,
          fieldset_legend: fieldsetLegend,
          role: node.getAttribute('role') || '',
          ariaReadonly: node.getAttribute('aria-readonly') || '',
          href: node.getAttribute('href') || '',
          disabled: Boolean(node.disabled),
          in_form: Boolean(formElement),
          // Never forward page-authored form IDs. A form can encode account or
          // session data in its id; this local ordinal is enough to model
          // relationships between controls.
          form_id: getFormGroupId(formElement),
          radio_group_id: getRadioGroupId(node),
          // Required-ness drives whether a field gets a vault value at all. A
          // page can mark any field required, so this is treated as a planning
          // hint and never as authorisation on its own — but without it the
          // agent cannot tell "the form cannot be submitted without this" from
          // "there is an optional marketing field here".
          required: Boolean(node.required || node.getAttribute('aria-required') === 'true'),
          readonly: Boolean(node.readOnly || node.hasAttribute?.('readonly') || node.getAttribute('aria-readonly') === 'true'),
          is_contenteditable: isContentEditable,
          checked: Boolean(node.checked),
          selected: tag === 'select'
            ? Boolean(node.options?.[node.selectedIndex]?.selected)
            : Boolean(node.selected),
          selected_option: tag === 'select' && node.selectedIndex >= 0
            ? {
                index: node.selectedIndex,
                text: String(node.options?.[node.selectedIndex]?.text || '').trim(),
                value: String(node.options?.[node.selectedIndex]?.value || '').trim()
              }
            : null,
          context,
          price_value,
          options,
          bbox: this.bboxOf(rect),
          is_interactive: true,
          is_visible: isRendered,
          // Separate, informational: the field exists and can be typed into
          // even when it sits below the fold. The executor scrolls it into
          // view before writing, so this never gates an action.
          in_viewport: isVisible
        });
      }

      const extractedIds = new Set(extracted.map((element) => element.id));
      const childrenByParent = new Map();
      for (const element of extracted) {
        let ancestor = element._node?.parentElement || null;
        let parentId = null;
        while (ancestor && !parentId) {
          const candidate = registry.getId(ancestor);
          if (candidate && extractedIds.has(candidate)) parentId = candidate;
          ancestor = ancestor.parentElement;
        }
        element.parent_element_id = parentId;
        if (parentId) {
          if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
          childrenByParent.get(parentId).push(element.id);
        }
      }
      for (const element of extracted) {
        element.child_element_ids = (childrenByParent.get(element.id) || []).slice(0, 20);
        delete element._node;
      }

      const main = document.querySelector('main, [role="main"], #content, .content') || document.body;
      const normalizedMainText = String(main?.innerText || '').replace(/\s+/g, ' ').trim();
      const visible_text = this.getVisiblePageText(main);
      const visibleTextComplete = normalizedMainText.length <= 4000;
      const interactiveElementsComplete = !elementLimitReached;

      return {
        snapshot_id: snapshotId,
        mutation_revision: stabilityObserver.revision,
        url: window.location.href,
        title: document.title || 'Untitled Document',
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          // CSS pixels. A captured screenshot is in DEVICE pixels, so on a 2x
          // display it is twice this in each dimension. Any coordinate carried
          // over from vision (the VLM reports boxes against the image it was
          // given) has to be divided by this factor before it can be used with
          // elementFromPoint, which takes CSS pixels. It was previously
          // undeclared anywhere in the project, so a vision-derived coordinate
          // on a HiDPI screen hit an element twice as far away.
          scale: window.devicePixelRatio || 1
        },
        scroll: {
          x: Math.round(window.scrollX || 0),
          y: Math.round(window.scrollY || 0),
          // The furthest scroll offset, not the document height. Reporting
          // scrollHeight here made a "scroll to the bottom" consumer overshoot
          // by one viewport.
          maxY: Math.max(0, Math.round(
            (document.documentElement?.scrollHeight || 0) - window.innerHeight
          ))
        },
        headings: this.extractHeadings(),
        result_items: this.extractResultItems(extracted),
        visible_text,
        // Minimal state for visible native media. It stays local and lets the
        // post-action verifier recognize PLAY/PAUSE even when surrounding DOM
        // and visible text do not change. No media URLs, text, or titles.
        local_media_state: this.extractVisibleMediaState(),
        // This local-only coverage bit is deliberately stricter than checking
        // that `elements` is an array. If either the interactive-element cap
        // truncated extraction or the page-text excerpt was cut, screenshots
        // cannot claim complete redaction coverage.
        privacy_coverage: {
          established: interactiveElementsComplete && visibleTextComplete,
          interactive_elements_complete: interactiveElementsComplete,
          visible_text_complete: visibleTextComplete
        },
        // Only a rendered, in-viewport canvas/video surface can contain
        // pixels that OCR cannot audit. Invisible analytics-pixel canvases
        // (common on modern pages) must not gut visual grounding for every
        // observation on the page.
        opaqueVisualSurface: this._hasOpaqueVisualSurface(),
        elements: extracted
      };
    }

    _hasOpaqueVisualSurface() {
      // Size gate first. A 1x1 tracking pixel, a hidden preload canvas or a
      // collapsed ad placeholder is technically a canvas/video/iframe but covers
      // no meaningful area, and treating it as an opaque surface withheld the
      // screenshot on virtually every modern page (every page has an analytics
      // pixel), which silently removed all visual grounding.
      const MIN_OPAQUE_AREA_PX = 4000; // ~63x63
      const MIN_OPAQUE_FRACTION = 0.02; // ...or 2% of the viewport
      const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
      for (const el of document.querySelectorAll('canvas, video, iframe')) {
        const rect = el.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) continue;
        if (!this.isElementVisible(el, rect)) continue;
        const area = rect.width * rect.height;
        if (area >= MIN_OPAQUE_AREA_PX || area / viewportArea >= MIN_OPAQUE_FRACTION) {
          return true;
        }
      }
      return false;
    }

    extractVisibleMediaState() {
      const media = [];
      for (const element of this.queryAllDeep('video, audio')) {
        if (element.isConnected === false) continue;
        const rect = element.getBoundingClientRect();
        if (!this.isElementVisible(element, rect)) continue;
        const tag = String(element.tagName || '').toLowerCase();
        if (tag !== 'video' && tag !== 'audio') continue;
        // Ordinals avoid forwarding page-authored ids that may encode
        // account or session data.
        media.push({
          ordinal: media.length,
          tag,
          paused: element.paused !== false,
          ended: Boolean(element.ended),
          ready_state: Number.isInteger(element.readyState)
            ? Math.max(0, Math.min(4, element.readyState))
            : 0
        });
        if (media.length >= 20) break;
      }
      return { visible_count: media.length, media };
    }
  }

  const domExtractor = new DOMExtractor();

  // 3. Visual Overlay.
  //
  // The overlay lives in a CLOSED shadow root attached to a single host element
  // that carries no id, class, or readable geometry of its own.
  //
  // It used to be two plain <div>s appended to <html> with fixed ids and inline
  // styles, which was bad twice over:
  //  - It was a reliable "this extension is installed" beacon on every site,
  //    which contradicts the product's entire premise.
  //  - The highlight's rect told a hostile page exactly what the agent was
  //    about to click: read the rect, call elementFromPoint on its centre, and
  //    swap in a decoy before the click landed.
  // A closed shadow root makes the internals unreadable from page script, and
  // clear() removes the host entirely rather than setting opacity to 0.
  class VisualOverlay {
    constructor() {
      this._host = null;
      this._root = null;
      this.cursorEl = null;
      this.highlightEl = null;
      this._clearTimer = null;
      this._reducedMotion = typeof window !== 'undefined' && window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    _ensureElements() {
      if (this._root) return;
      const host = document.createElement('div');
      // No id, no class: nothing for a page to query on. The host is inert and
      // must not intercept pointer events meant for the page beneath it.
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
      const root = host.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial; }
        .cursor {
          position: fixed;
          width: 22px; height: 22px;
          background: radial-gradient(circle, rgba(99,102,241,0.9) 0%, rgba(79,70,229,0.5) 70%, transparent 100%);
          border: 2px solid #ffffff; border-radius: 50%;
          pointer-events: none; opacity: 0;
          transform: translate(-50%, -50%);
          transition: transform 0.25s cubic-bezier(0.2,0.8,0.2,1), opacity 0.2s ease;
          box-shadow: 0 0 12px rgba(99,102,241,0.8);
        }
        .highlight {
          position: fixed;
          border: 2px solid #6366f1;
          background: rgba(99,102,241,0.12);
          border-radius: 6px; pointer-events: none; opacity: 0;
          transition: all 0.2s ease;
          box-shadow: 0 0 8px rgba(99,102,241,0.4);
        }
      `;
      root.appendChild(style);

      const cursor = document.createElement('div');
      cursor.className = 'cursor';
      const highlight = document.createElement('div');
      highlight.className = 'highlight';
      root.appendChild(cursor);
      root.appendChild(highlight);

      (document.documentElement || document.body).appendChild(host);
      // The page stability observer watches documentElement so it can detect a
      // replaced body. Keep our closed-shadow overlay out of the observation
      // revision; otherwise the agent would invalidate its own click target.
      stabilityObserver.ignoreNode(host);
      this._host = host;
      this._root = root;
      this.cursorEl = cursor;
      this.highlightEl = highlight;
    }

    /**
     * Draw the highlight box and the cursor over an element.
     *
     * Positions are viewport-relative (`fixed`) rather than page-relative, so
     * no scroll offset is added. That also means the page cannot read a
     * meaningful page coordinate out of the style, and getBoundingClientRect on
     * the host returns nothing usable from page script.
     */
    highlightElement(element) {
      this._ensureElements();
      if (!element || !this.highlightEl) return;
      const rect = element.getBoundingClientRect();

      this.highlightEl.style.left = `${rect.left - 3}px`;
      this.highlightEl.style.top = `${rect.top - 3}px`;
      this.highlightEl.style.width = `${rect.width + 6}px`;
      this.highlightEl.style.height = `${rect.height + 6}px`;
      this.highlightEl.style.opacity = '1';

      if (this.cursorEl) {
        this.cursorEl.style.left = `${rect.left + rect.width / 2}px`;
        this.cursorEl.style.top = `${rect.top + rect.height / 2}px`;
        this.cursorEl.style.opacity = '1';
      }

      if (this._clearTimer) clearTimeout(this._clearTimer);
      this._clearTimer = setTimeout(() => this.clear(), 1800);
    }

    /**
     * Tear the overlay down completely. Leaving the nodes in place — even at
     * opacity 0 — kept the extension detectable and kept the previous target's
     * rect sitting in the DOM.
     */
    clear() {
      if (this._clearTimer) { clearTimeout(this._clearTimer); this._clearTimer = null; }
      if (this._host) {
        try { this._host.remove(); } catch { /* already detached */ }
      }
      this._host = null;
      this._root = null;
      this.cursorEl = null;
      this.highlightEl = null;
    }
  }

  const visualOverlay = new VisualOverlay();

  // 4. Page Stability Observer
  class PageStabilityObserver {
    constructor() {
      this.lastMutationTime = Date.now();
      this.revision = 0;
      this.observer = null;
      this.ignoredNodes = new WeakSet();
      this._mutationFlushTimer = null;
      this._startObserving();
    }

    _startObserving() {
      if (typeof MutationObserver === 'undefined') return;
      const target = (typeof document !== 'undefined') ? (document.documentElement || document.body) : null;
      if (!target) {
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('DOMContentLoaded', () => this._startObserving(), { once: true });
        }
        return;
      }
      if (this.observer) {
        try { this.observer.disconnect(); } catch {}
      }
      this.observer = new MutationObserver((records) => {
        const changed = Array.from(records || []).some((record) => {
          if (this.ignoredNodes.has(record.target)) return false;
          if (record.type !== 'childList') return true;
          const nodes = [...Array.from(record.addedNodes || []), ...Array.from(record.removedNodes || [])];
          return nodes.some((node) => !this.ignoredNodes.has(node));
        });
        if (!changed) return;
        // Coalesce bursts. A page like YouTube writes attributes and text on
        // every animation frame, so this callback can fire hundreds of times a
        // second; each call is cheap but the volume is real main-thread cost.
        // Revision is a monotonic counter, so bumping it once per burst is
        // equivalent for the staleness comparisons that read it.
        if (this._mutationFlushTimer !== null) return;
        this._mutationFlushTimer = setTimeout(() => {
          this._mutationFlushTimer = null;
          this.lastMutationTime = Date.now();
          this.revision += 1;
        }, MUTATION_COALESCE_MS);
      });
      try {
        // attributeFilter is the important half: without it Blink must build a
        // MutationRecord for EVERY attribute write anywhere in the document.
        // These are the attributes that can change what an element IS or what
        // it is worth; everything else (a CSS class for a hover style, a data
        // attribute for a framework's internal bookkeeping) cannot affect
        // extraction and no longer wakes the observer at all.
        this.observer.observe(target, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: OBSERVED_ATTRIBUTES,
          characterData: true
        });
      } catch {
        // attributeFilter is widely supported but must not be load-bearing:
        // if it is rejected, fall back to the unfiltered observation.
        try {
          this.observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
        } catch {}
      }
    }

    markAction() {
      this.lastMutationTime = Date.now();
    }

    ignoreNode(node) {
      if (node && typeof node === 'object') this.ignoredNodes.add(node);
    }

    /**
     * Waits for the document to stop mutating.
     * @returns {Promise<boolean>} true when the page was quiet for `quietMs`,
     *   false when it never settled inside `timeoutMs`. Callers must not read a
     *   timeout as "stable": a continuously rendering page would otherwise be
     *   reported as settled, which is how an observation could be taken
     *   mid-render and then treated as authoritative.
     */
    async waitForStability(quietMs = 120, timeoutMs = 1500) {
      if (!this.observer) this._startObserving();
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        if (Date.now() - this.lastMutationTime >= quietMs) {
          return true;
        }
        await new Promise(r => setTimeout(r, 25));
      }
      return false;
    }
  }

  const stabilityObserver = new PageStabilityObserver();

  // 5. Browser Action Executor
  class BrowserExecutor {
    /**
     * Rejects a plan whose observation is no longer current.
     *
     * Freshness is decided by the identity of the observation and of the
     * element it addressed, never by a document-wide mutation counter. The
     * observer watches attributes and character data across the whole
     * document, so on any page that renders live — a video player's clock,
     * view counts, ad slots, carousels — that counter changes continuously and
     * equality against it can never hold. Requiring it rejected every action on
     * a dynamic page, which is what stopped the agent from playing a video.
     *
     * What the target-scoped check still catches is everything the global
     * counter was actually protecting against: a new extraction (ids are
     * reassigned), a navigation, and a target that was detached, replaced or
     * rebuilt. Actions dispatch on the resolved node reference rather than on
     * coordinates, so a list that merely reorders cannot mis-click.
     */
    _assertFreshObservation(context, targetElementId) {
      if (!context || context.snapshotId !== registry.snapshotId) {
        throw new Error('The page changed after this observation. Re-observe and ground the action again.');
      }
      if (!targetElementId) return;
      const element = registry.getElement(targetElementId);
      if (!element || !element.isConnected) {
        throw new Error('Target element became stale after observation. Re-observe the page before acting.');
      }
    }

    async execute(actionPayload) {
      const { action, target, resolvedValue, coordinates } = actionPayload;

      // Element IDs are scoped to one content-script snapshot, so a navigation
      // or a newer observation invalidates the plan and the background must
      // observe and ground the page again. The target's own liveness is checked
      // against the registry rather than against a document-wide mutation
      // counter — see _assertFreshObservation.
      if (OBSERVATION_BOUND_ACTIONS.has(action)) {
        this._assertFreshObservation(actionPayload.observationContext, target?.element_id);
      }

      let targetElement = null;
      if (target?.element_id) {
        targetElement = registry.getElement(target.element_id);
        if (targetElement && !targetElement.isConnected) {
          throw new Error('Target element became stale after observation. Re-observe the page before acting.');
        }
        if (!targetElement) {
          // No id-based fallback. A coordinate hit or a getElementById guess
          // would act on something the observation never described.
          throw new Error('Target element is no longer present. Re-observe the page before acting.');
        }
      }

      if (targetElement) {
        const smoothOk = !(typeof window !== 'undefined' && window.matchMedia &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        targetElement.scrollIntoView({ behavior: smoothOk ? 'smooth' : 'auto', block: 'center', inline: 'nearest' });
        visualOverlay.highlightElement(targetElement);
        // Let the scroll settle, then re-resolve. Resolving before the scroll
        // and using that result afterwards meant the highlight could sit on one
        // element while the click landed on another: scrollIntoView is
        // fire-and-forget, so layout, sticky headers and lazy images all shift
        // underneath during the animation.
        await this.sleep(SCROLL_SETTLE_MS);
        const settled = registry.getElement(target.element_id);
        if (settled && settled.isConnected) targetElement = settled;
        // Re-check after the scroll. The scroll itself mutates the document, so
        // this can no longer be a whole-document freshness test; what matters
        // is that the element we are about to act on is still the live node
        // this observation described.
        if (OBSERVATION_BOUND_ACTIONS.has(action)) {
          this._assertFreshObservation(actionPayload.observationContext, target.element_id);
        }
      }

      switch (action) {
        case 'CLICK':
          return this._executeClick(targetElement, coordinates);

        case 'TYPE':
          return this._executeType(targetElement, resolvedValue);

        case 'SELECT':
          return this._executeSelect(targetElement, resolvedValue);

        case 'CHECK':
          if (targetElement) {
            if (String(targetElement.getAttribute?.('role') || '').toLowerCase() === 'checkbox') {
              if (targetElement.getAttribute('aria-checked') === 'true') return { success: true, changed: false };
              targetElement.click();
              await this._waitForFieldSettle(targetElement);
              const checked = targetElement.getAttribute('aria-checked') === 'true';
              return { success: checked, ...(checked ? {} : { error: 'The checkbox did not accept the checked state.' }) };
            }
            if (String(targetElement.getAttribute?.('role') || '').toLowerCase() === 'radio') {
              if (targetElement.getAttribute('aria-checked') === 'true') return { success: true, changed: false };
              targetElement.click();
              await this._waitForFieldSettle(targetElement);
              const checked = targetElement.getAttribute('aria-checked') === 'true';
              return { success: checked, ...(checked ? {} : { error: 'The radio option did not become selected.' }) };
            }
            // Already in the desired state: do not re-notify framework
            // listeners with a synthetic change event.
            if (targetElement.checked) return { success: true, changed: false };
            if (typeof targetElement.click === 'function') targetElement.click();
            else { targetElement.checked = true; targetElement.dispatchEvent(new Event('change', { bubbles: true })); }
            if (!targetElement.checked) return { success: false, error: 'The control did not accept the checked state.' };
          }
          return { success: true };

        case 'UNCHECK':
          if (targetElement) {
            if (String(targetElement.getAttribute?.('role') || '').toLowerCase() === 'checkbox') {
              if (targetElement.getAttribute('aria-checked') === 'false') return { success: true, changed: false };
              targetElement.click();
              await this.sleep(40);
              const unchecked = targetElement.getAttribute('aria-checked') === 'false';
              return { success: unchecked, ...(unchecked ? {} : { error: 'The checkbox did not accept the unchecked state.' }) };
            }
            if (String(targetElement.type || '').toLowerCase() === 'radio' ||
                String(targetElement.getAttribute?.('role') || '').toLowerCase() === 'radio') {
              return { success: false, error: 'A radio option cannot be unchecked without selecting another option.' };
            }
            if (!targetElement.checked) return { success: true, changed: false };
            if (typeof targetElement.click === 'function') targetElement.click();
            else { targetElement.checked = false; targetElement.dispatchEvent(new Event('change', { bubbles: true })); }
            if (targetElement.checked) return { success: false, error: 'The control did not accept the unchecked state.' };
          }
          return { success: true };

        case 'SCROLL': {
          // Instant, not smooth: a smooth animation is still in flight when
          // the 250 ms wait ends, so the next observation could catch a
          // half-scrolled page and report fields as missing.
          const deltaY = Number.isFinite(Number(actionPayload.deltaY)) ? Number(actionPayload.deltaY) : 300;
          const deltaX = Number.isFinite(Number(actionPayload.deltaX)) ? Number(actionPayload.deltaX) : 0;
          const before = { x: window.scrollX || 0, y: window.scrollY || 0 };
          window.scrollBy({ left: deltaX, top: deltaY, behavior: 'auto' });
          // Some sites (and any scrollable inner panel) move without the
          // window moving at all. If the document did not budge, retry on the
          // nearest scrollable ancestor so SCROLL is not a silent no-op.
          let moved = Math.abs((window.scrollY || 0) - before.y) > 1 ||
                      Math.abs((window.scrollX || 0) - before.x) > 1;
          if (!moved) {
            const scroller = this._nearestScrollableParent(targetElement);
            if (scroller) {
              scroller.scrollTop += deltaY;
              scroller.scrollLeft += deltaX;
              moved = true;
            }
          }
          await this.sleep(SCROLL_SETTLE_MS);
          return {
            success: true,
            moved,
            scroll: {
              x: Math.round(window.scrollX || 0),
              y: Math.round(window.scrollY || 0),
              maxY: Math.max(0, Math.round(
                (document.documentElement?.scrollHeight || 0) - window.innerHeight
              ))
            }
          };
        }

        case 'UPLOAD':
          if (!isVaultDocumentPayload(resolvedValue)) {
            throw new Error('Choose a named document from the local vault before attaching a file.');
          }
          return this._executeVaultDocumentUpload(targetElement, resolvedValue);

        case 'SUBMIT':
          return this._executeSubmit(targetElement);

        case 'FILL_FORM_PLAN': {
          const plan = resolvedValue?.fields ? resolvedValue : resolvedValue?.value?.fields ? resolvedValue.value : actionPayload.value?.fields ? actionPayload.value : null;
          return this._executeFormPlan(plan, actionPayload.observationContext);
        }

        case 'EXTRACT': {
          const main = document.querySelector('main, [role="main"], #content, .content') || document.body;
          const text = String(main?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
          return { success: true, extractedText: text, url: window.location.href, title: document.title };
        }

        case 'ASK_USER': {
          const raw = resolvedValue ?? actionPayload.value ?? target?.prompt ?? 'User input required';
          // Planner sends { prompt, ambiguousFields } for clarification
          // requests; accept a plain string for backward compatibility.
          const promptText = (raw && typeof raw === 'object' && typeof raw.prompt === 'string')
            ? raw.prompt
            : String(raw);
          const fields = (raw && typeof raw === 'object' && Array.isArray(raw.ambiguousFields))
            ? raw.ambiguousFields
            : undefined;
          return { success: true, needs_user_input: true, prompt: promptText.slice(0, 500), ...(fields ? { ambiguousFields: fields } : {}) };
        }

        case 'OPEN_TAB': {
          const url = target?.url || resolvedValue || actionPayload.value;
          if (url && typeof url === 'string' && /^https?:\/\//i.test(url)) {
            const opened = window.open(url, '_blank');
            // Never fake success: a popup-blocked open returns null.
            if (!opened) {
              return { success: false, error: 'The browser blocked the new tab. Allow popups for this site, or use NAVIGATE for same-tab navigation.' };
            }
            return { success: true, openedUrl: url };
          }
          return { success: false, error: 'OPEN_TAB needs a valid http(s) URL; use NAVIGATE for same-tab navigation.' };
        }

        case 'SWITCH_TAB': {
          // The page world cannot focus another tab. Report the limitation
          // honestly so the planner re-grounds with NAVIGATE instead of
          // assuming a switch happened.
          return { success: false, error: 'SWITCH_TAB is not supported in the page context; use NAVIGATE for same-tab navigation.' };
        }

        case 'WAIT': {
          // Bound the wait: an unvalidated model-proposed duration could
          // stall the agent loop for hours.
          const duration = Math.min(30000, Math.max(0, Number(actionPayload.duration) || 1000));
          await this.sleep(duration);
          return { success: true };
        }

        case 'PRESS_KEY':
          return this._executePressKey(targetElement, actionPayload);
        case 'HOVER':
          if (targetElement) {
            targetElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
            targetElement.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
            return { success: true };
          }
          throw new Error('Target hover element not found');
        case 'GO_BACK':
          window.history.back();
          await this.sleep(600);
          return { success: true };
        case 'GO_FORWARD':
          window.history.forward();
          await this.sleep(600);
          return { success: true };

        default:
          // Never fake success: unsupported verbs must fail loudly so the
          // planner re-grounds instead of assuming progress.
          return { success: false, error: `Unsupported content action: ${action}` };
      }
    }

    async _executeClick(element, coords) {
      if (element) {
        element.focus();
        // .click() ALONE. HTMLElement.click() synthesises the whole
        // pointerdown -> mousedown -> pointerup -> mouseup -> click sequence
        // itself, so dispatching the first three by hand and then calling
        // .click() delivered every handler in that sequence twice. Anything
        // that toggles on mousedown (custom role=checkbox/radio widgets, which
        // are extremely common) saw two toggles and netted out to no change at
        // all, which looks exactly like a dead page.
        element.click();
        // Report BEFORE waiting. A click that navigates commits within a few
        // milliseconds, which tears down this document along with every pending
        // timer in it -- so an await here means sendResponse() never runs and
        // the background sees "The message port closed before a response was
        // received". That turned every link click, form submit and SPA route
        // change into a phantom failure, and it is why playback could never be
        // certified from a link click. Only wait when the click demonstrably
        // did NOT tear the page down.
        if (!this._clickMayNavigate(element)) {
          await this._waitForFieldSettle(element);
        }
        return { success: true };
      }

      if (coords && coords.length === 2) {
        const el = document.elementFromPoint(coords[0], coords[1]);
        if (el) {
          el.click();
          if (!this._clickMayNavigate(el)) {
            await this._waitForFieldSettle(el);
          }
          return { success: true };
        }
      }

      throw new Error('Target click element not found');
    }

    /**
     * True when clicking this element can unload the document or swap the view.
     *
     * The tell is that the click has somewhere to GO: a real href, a form
     * owner, or a submit button. Those must be answered synchronously. Clicks
     * on plain controls stay in the page, so settling after them is safe and
     * gives the verifier a chance to observe the reaction.
     */
    _clickMayNavigate(element) {
      if (!element || typeof element !== 'object') return true;
      try {
        if (element.isConnected === false) return true;
        const tag = String(element.tagName || '').toUpperCase();
        if (tag === 'A' && element.getAttribute('href')) return true;
        if (tag === 'AREA' && element.getAttribute('href')) return true;
        if (tag === 'FORM') return true;
        if (tag === 'BUTTON') {
          const type = String(element.getAttribute('type') || 'submit').toLowerCase();
          if (type === 'submit' && (element.form || element.closest?.('form'))) return true;
        }
        if (tag === 'INPUT') {
          const type = String(element.getAttribute('type') || '').toLowerCase();
          if (['submit', 'image', 'reset'].includes(type)) return true;
        }
        // A link-ish or button-ish custom control: role and tabindex are the
        // only signals available, and both appear on SPA route handlers.
        const role = String(element.getAttribute?.('role') || '').toLowerCase();
        if (role === 'link' || role === 'button' || role === 'menuitem') return true;
        if (element.closest?.('a[href], form')) return true;
        return false;
      } catch {
        // If we cannot tell, assume the worst and answer synchronously.
        return true;
      }
    }

    async _executeType(element, text) {
      if (!element) throw new Error('Target type element not found');

      // A document token is a file, not text. It may only ever land in a file
      // input; typing it anywhere else is refused rather than coerced.
      if (isVaultDocumentPayload(text)) {
        throw new Error('A stored document must use UPLOAD on a file input.');
      }
      if (typeof text === 'string' && DOCUMENT_NAME_TOKEN.test(text)) {
        throw new Error('A stored document token cannot be typed as text; use UPLOAD on a file input.');
      }

      if (String(element.type || '').toLowerCase() === 'file') {
        throw new Error('File inputs require UPLOAD with a named document from the local vault.');
      }
      if (typeof text === 'object' && text !== null) {
        throw new Error('A structured value cannot be typed into a text field.');
      }
      if (element.disabled || this._isReadOnlyControl(element)) {
        return { success: false, error: 'The field is disabled or read-only.' };
      }

      // Native date inputs reject non-ISO strings (value stays ''); normalize first.
      let rawText = text;
      try {
        if (String(element.type || '').toLowerCase() === 'date' && typeof text === 'string') {
          const t = text.trim();
          if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
            rawText = t;
          } else {
            const ymd = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
            if (ymd) {
              rawText = `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
            } else {
              const m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
              if (m) {
                let year = m[3];
                if (year.length === 2) {
                  const yNum = Number(year);
                  year = yNum < 70 ? `20${year}` : `19${year}`;
                }
                const first = Number(m[1]);
                const second = Number(m[2]);
                const monthFirst = first <= 12 && second > 12;
                rawText = monthFirst
                  ? `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
                  : `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
              } else {
                const parsed = new Date(t);
                if (!isNaN(parsed.getTime())) {
                  const yyyy = parsed.getFullYear();
                  const mm = String(parsed.getMonth() + 1).padStart(2, '0');
                  const dd = String(parsed.getDate()).padStart(2, '0');
                  rawText = `${yyyy}-${mm}-${dd}`;
                }
              }
            }
          }
        }
      } catch { /* use original text */ }
      const valueToSet = String(rawText || '');
      const tag = String(element.tagName || '').toUpperCase();
      const isEditable = Boolean(element.isContentEditable) ||
        String(element.getAttribute?.('role') || '').toLowerCase() === 'textbox';
      const previousValue = isEditable && element.isContentEditable
        ? String(element.textContent || '')
        : String(element.value ?? '');

      // Reject constraints the browser would never allow a user to satisfy
      // before touching the field. In particular, do not clear a pre-existing
      // value and then report a maxlength failure.
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const maxlengthAttr = element.getAttribute?.('maxlength');
        const hasMaxlength = element.hasAttribute ? element.hasAttribute('maxlength') : maxlengthAttr !== null && maxlengthAttr !== undefined;
        const maxlength = Number(maxlengthAttr);
        if (hasMaxlength && Number.isInteger(maxlength) && maxlength >= 0 && valueToSet.length > maxlength) {
          return { success: false, error: `Value exceeds the field limit (at most ${maxlength} characters).` };
        }
        const minlengthAttr = element.getAttribute?.('minlength');
        const hasMinlength = element.hasAttribute ? element.hasAttribute('minlength') : minlengthAttr !== null && minlengthAttr !== undefined;
        const minlength = Number(minlengthAttr);
        if (valueToSet && hasMinlength && Number.isInteger(minlength) && minlength > 0 && valueToSet.length < minlength) {
          return { success: false, error: `Value is shorter than the field's ${minlength}-character minimum.` };
        }
        const pattern = element.getAttribute?.('pattern');
        if (pattern) {
          try {
            if (!new RegExp(`^(?:${pattern})$`, 'u').test(valueToSet)) {
              return { success: false, error: 'The value does not match the field format.' };
            }
          } catch { /* invalid page-authored patterns are ignored by browsers */ }
        }
      }

      if (!isEditable && tag !== 'INPUT' && tag !== 'TEXTAREA' && !('value' in element)) {
        return { success: false, error: 'This custom field does not expose a writable text value.' };
      }
      element.focus();
      try {
        if (element.isContentEditable) {
          element.textContent = valueToSet;
        } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
          const prototype = tag === 'INPUT'
            ? window.HTMLInputElement?.prototype
            : window.HTMLTextAreaElement?.prototype;
          const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (setter) setter.call(element, valueToSet);
          else element.value = valueToSet;
        } else {
          // A custom textbox may expose a real `value` property. A plain div
          // with role=textbox is only writable when contenteditable is set.
          element.value = valueToSet;
        }
      } catch {
        if (element.isContentEditable) element.textContent = valueToSet;
        else if ('value' in element) element.value = valueToSet;
      }

      const actualValue = element.isContentEditable
        ? String(element.textContent || '')
        : String(element.value ?? '');
      if (actualValue !== valueToSet) {
        // Native date/number controls can silently reject malformed values.
        // Restore the previous user value without sending a misleading event.
        try {
          if (element.isContentEditable) element.textContent = previousValue;
          else if (tag === 'INPUT' || tag === 'TEXTAREA') {
            const prototype = tag === 'INPUT' ? window.HTMLInputElement?.prototype : window.HTMLTextAreaElement?.prototype;
            const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
            if (setter) setter.call(element, previousValue);
            else element.value = previousValue;
          } else element.value = previousValue;
        } catch { /* preserve the best state the browser allows */ }
        return { success: false, error: 'The field rejected the value (wrong format for this input type).' };
      }
      this._dispatchValueEvents(element, valueToSet);
      await this._waitForFieldSettle(element);
      // No synthetic Enter keyup here: pages with keyup-Enter submit handlers
      // (chats, search bars) would submit prematurely during a typing step.

      const settledValue = element.isContentEditable
        ? String(element.textContent || '')
        : String(element.value ?? '');
      if (settledValue !== valueToSet) {
        return { success: false, error: 'The field did not retain the requested value.' };
      }
      return { success: true };
    }

    _isReadOnlyControl(element) {
      return Boolean(element?.readOnly || element?.hasAttribute?.('readonly') ||
        String(element?.getAttribute?.('aria-readonly') || '').toLowerCase() === 'true');
    }

    _dispatchValueEvents(element, value) {
      let inputEvent;
      try {
        inputEvent = typeof InputEvent === 'function'
          ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) })
          : new Event('input', { bubbles: true });
      } catch {
        inputEvent = new Event('input', { bubbles: true });
      }
      element.dispatchEvent(inputEvent);
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async _executeSelect(element, optionValue) {
      if (!element) throw new Error('Target select element not found');
      if (String(element.tagName || '').toLowerCase() !== 'select') {
        return { success: false, error: 'SELECT only supports a native select control.' };
      }
      if (element.disabled || this._isReadOnlyControl(element)) {
        return { success: false, error: 'The dropdown is disabled or read-only.' };
      }
      element.focus();
      const str = String(optionValue ?? '').toLowerCase().trim();
      const options = Array.from(element.options || []);
      // An empty value must select nothing. Previously `text.includes('')`
      // matched every option, so a blank value committed option 0 — a real,
      // wrong data write on any country or state select.
      let opt = null;
      if (str) {
        opt = options.find(o =>
          String(o.value ?? '').toLowerCase().trim() === str ||
          String(o.text ?? '').toLowerCase().trim() === str
        ) || null;
        if (!opt) {
          // Substring matching only for a target long enough to be
          // unambiguous, and only when it covers most of the option text, so
          // "y" cannot match "New York".
          opt = options.find(o => {
            const text = String(o.text ?? '').toLowerCase().trim();
            return str.length >= 5 && text.includes(str) && str.length >= text.length * 0.6;
          }) || null;
        }
      }
      if (!opt) {
        // Do not echo a proposed value in an error message; select values can
        // contain personal data and the result may be included in task history.
        return { success: false, error: 'No option on this dropdown matches the requested value.' };
      }

      const valueToSet = opt.value;

      try {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
        if (setter) {
          setter.call(element, valueToSet);
        } else {
          element.value = valueToSet;
        }
      } catch {
        element.value = valueToSet;
      }
      
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      await this._waitForFieldSettle(element);
      if (element.selectedIndex < 0 || element.value !== valueToSet) {
        return { success: false, error: 'The dropdown did not accept the option.' };
      }
      return { success: true };
    }

    /**
     * Attach a document the USER stored in the local vault, by name.
     *
     * What can reach this method is one descriptor: a name matching
     * LOCAL_DOCUMENT_<NAME>, a base64 body, a file name and a MIME type. There
     * is no file path, no directory, no picker, and no way to name a file the
     * user did not store. The model chooses WHICH of the user's own documents
     * to attach; it can never choose a file to read.
     *
     * The bytes are used to construct a File and are never logged, returned,
     * or attached to the response.
     */
    async _executeVaultDocumentUpload(element, doc) {
      if (!element) throw new Error('Target upload element not found');
      if (!isVaultDocumentPayload(doc)) {
        throw new Error('A stored document must be supplied as a vault document descriptor.');
      }

      // The target must be a real file input. Anything else — a text box, a
      // contenteditable, a drop zone, a non-element — is refused.
      const tag = String(element.tagName || '').toUpperCase();
      const type = String(element.type || '').toLowerCase();
      if (tag !== 'INPUT' || type !== 'file') {
        throw new Error('A stored document can only be attached to a file input.');
      }
      if (element.disabled) {
        throw new Error('The file input on this page is disabled.');
      }

      const bytes = decodeVaultDocumentBytes(doc);
      if (!bytes || !bytes.length) {
        throw new Error('The stored document could not be read. Save it again from the vault.');
      }

      const fileName = String(doc.fileName || 'document').replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 128);
      const mimeType = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i
        .test(String(doc.mimeType || '')) ? String(doc.mimeType) : 'application/octet-stream';

      // Respect an explicit accept list when the site declares one: a document
      // is not silently attached to a field that only accepts a different type.
      const accept = String(element.getAttribute?.('accept') || '').trim();
      if (accept && !matchesAcceptAttribute(accept, fileName, mimeType)) {
        throw new Error(`This field only accepts ${accept}, which the stored document does not match.`);
      }

      const file = new File([bytes], fileName, { type: mimeType });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      element.files = dataTransfer.files;

      // React, Angular and Vue all track file inputs through their own change
      // listeners; without both events the page keeps believing the field is
      // empty and never submits what was attached.
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));

      // The result carries the file NAME only. The document name is the token
      // the model already knows; the bytes are never echoed back anywhere.
      // Deliberately NOT returning the file name. This result object is stored on the
      // task and feeds `task_history`, which the planner sees on the next step,
      // and the local vault's whole premise is that file names never leave the
      // device. `doc.name` is the sanitized LOCAL_DOCUMENT_<NAME> token the user
      // chose in the side panel, which is already safe to display.
      return { success: true, document: doc.name, byteLength: doc.byteLength };
    }

    async _executeSubmit(element) {
      if (element) {
        if (typeof element.click === 'function') {
          element.click();
        } else if (element.tagName === 'FORM') {
          if (element.requestSubmit) element.requestSubmit();
          else element.submit();
        }
        return { success: true };
      }
      throw new Error('Target submit button not found');
    }

    /**
     * Fill a multi-field plan.
     *
     * Every target is resolved ONCE, before the first await, and the resulting
     * live element references are reused for the whole plan.
     *
     * The previous version re-resolved each `field_id` inside the loop, after
     * that field's scroll and settle delays. Element ids are positional — the
     * registry is cleared and renumbered on every extraction — so a re-render or
     * a concurrent EXTRACT_DOM partway through a plan made `el_7` name a
     * *different* node, and the vault value for one field was written into
     * another. The `getElementById`/`[name=]` fallback made it worse: a page
     * can simply ship `<input id="el_7">` and receive the secret.
     *
     * There is no id-based fallback here at all. If the registry no longer knows
     * a field, the field is reported as unresolvable rather than being guessed
     * at from page-controlled attributes.
     */
    async _executeFormPlan(plan, observationContext) {
      const fields = plan?.fields || [];
      if (!fields.length) throw new Error('Form plan has no fields to fill');
      const details = [];

      // Phase 1: resolve every target up front, while ids still mean something.
      const resolved = fields.map((field) => {
        if (isVaultDocumentPayload(field?.value) ||
            (typeof field?.value === 'string' && DOCUMENT_NAME_TOKEN.test(field.value)) ||
            (typeof field?.value_source === 'string' && DOCUMENT_NAME_TOKEN.test(field.value_source))) {
          return { field, el: null, reason: 'A stored document must use UPLOAD on a file input.' };
        }
        if (field.value === undefined || field.value === null || field.value === '') {
          return { field, el: null, reason: `Missing value for "${field.field_id}" (${field.value_source || 'no source'})` };
        }
        const el = field.field_id ? registry.getElement(field.field_id) : null;
        if (!el) return { field, el: null, reason: 'Element not found (page changed since observation)' };
        if (!el.isConnected) return { field, el: null, reason: 'Element was removed from the page' };
        if (el.disabled || this._isReadOnlyControl(el)) {
          return { field, el: null, reason: 'Field is disabled or read-only' };
        }
        // The plan was built against an observation. If the control has become
        // something else, the value does not belong in it — a card number must
        // never follow a field that turned into a search box.
        const expected = String(field.control_type || '').toUpperCase();
        if (expected && this._controlTypeOf(el) !== expected) {
          return { field, el: null, reason: `Field type changed (expected ${expected}, found ${this._controlTypeOf(el)})` };
        }
        return { field, el, signature: this._formControlSignature(el), formElement: el.form || el.closest?.('form') || null, reason: null };
      });

      // Phase 2: fill, reusing the references captured above.
      try {
        // Check the page snapshot once before the first mutation. Rechecking
        // the global mutation revision between fields would reject our own
        // input events and contenteditable writes, preventing the rest of an
        // otherwise grounded form plan from running.
        this._assertFreshObservation(observationContext);
      } catch (error) {
        return {
          success: false,
          details: resolved.map((item) => ({ field: item.field?.field_id, success: false, reason: error.message }))
        };
      }
      for (const item of resolved) {
        if (!item.el) {
          details.push({ field: item.field.field_id, success: false, reason: item.reason });
          continue;
        }
        const { field, el } = item;
        if (!el.isConnected) {
          details.push({ field: field.field_id, success: false, reason: 'Element was removed while filling' });
          continue;
        }
        if (this._formControlSignature(el) !== item.signature || (el.form || el.closest?.('form') || null) !== item.formElement) {
          details.push({ field: field.field_id, success: false, reason: 'Field identity changed after the plan was grounded' });
          continue;
        }
        try {
          await this._fillPlanElement(el, field.value, field);
          if (!el.isConnected) {
            details.push({ field: field.field_id, success: false, reason: 'Element was removed while filling' });
            continue;
          }
          const ok = this._verifyPlanElement(el, field.value, field);
          details.push({ field: field.field_id, success: ok, ...(ok ? {} : { reason: 'Verification failed: value mismatch' }) });
        } catch (e) {
          details.push({ field: field.field_id, success: false, reason: e.message });
        }
      }
      return { success: details.length > 0 && details.every(r => r.success), details };
    }

    /** DOM-level control kind used by form plans. */
    _controlTypeOf(el) {
      const tag = String(el?.tagName || '').toLowerCase();
      const type = String(el?.type || '').toLowerCase();
      const role = String(el?.getAttribute?.('role') || '').toLowerCase();
      if (tag === 'select') return 'SELECT';
      if (tag === 'textarea' || el?.isContentEditable || role === 'textbox') return 'TEXTAREA';
      if (type === 'radio') return 'RADIO';
      if (type === 'checkbox' || role === 'checkbox') return 'CHECKBOX';
      if (role === 'radio') return 'RADIO';
      if (type === 'email') return 'EMAIL';
      if (type === 'tel') return 'PHONE';
      if (type === 'number') return 'NUMBER';
      if (['date', 'datetime-local', 'month', 'week'].includes(type)) return 'DATE';
      return 'TEXT';
    }

    _formControlSignature(el) {
      const attributes = ['id', 'name', 'type', 'role', 'aria-label', 'aria-labelledby', 'placeholder', 'autocomplete'];
      return JSON.stringify([
        String(el?.tagName || '').toLowerCase(),
        Boolean(el?.isContentEditable),
        ...attributes.map((name) => String(el?.getAttribute?.(name) || ''))
      ]);
    }

    _normalizeDateForInput(el, value) {
      try {
        const type = String(el?.type || '').toLowerCase();
        if (!['date', 'datetime-local', 'month', 'week'].includes(type) || typeof value !== 'string') return value;
        const trimmed = value.trim();
        if (!trimmed) return '';
        if (type === 'datetime-local') {
          const localDateTime = trimmed.replace(' ', 'T');
          return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(localDateTime)
            ? localDateTime
            : value;
        }
        if (type === 'month') {
          const month = trimmed.match(/^(\d{4})[-/](\d{1,2})$/);
          return month ? `${month[1]}-${month[2].padStart(2, '0')}` : value;
        }
        if (type === 'week') {
          const week = trimmed.match(/^(\d{4})[- ]?[Ww](\d{1,2})$/);
          return week ? `${week[1]}-W${week[2].padStart(2, '0')}` : value;
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

        const ymd = trimmed.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
        if (ymd) {
          return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
        }

        const m = trimmed.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
        if (m) {
          let year = m[3];
          if (year.length === 2) {
            const yNum = Number(year);
            year = yNum < 70 ? `20${year}` : `19${year}`;
          }
          const first = Number(m[1]);
          const second = Number(m[2]);
          const monthFirst = first <= 12 && second > 12;
          return monthFirst
            ? `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
            : `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
        }

        const parsed = new Date(trimmed);
        if (!isNaN(parsed.getTime())) {
          const yyyy = parsed.getFullYear();
          const mm = String(parsed.getMonth() + 1).padStart(2, '0');
          const dd = String(parsed.getDate()).padStart(2, '0');
          return `${yyyy}-${mm}-${dd}`;
        }
      } catch { /* fall through with original value */ }
      return value;
    }

    /** Nearest ancestor that actually scrolls; null when the window is the scroller. */
    _nearestScrollableParent(element) {
      let node = element?.parentElement || null;
      while (node && node !== document.body && node !== document.documentElement) {
        const style = window.getComputedStyle(node);
        const overflowY = String(style?.overflowY || '');
        const scrollable = node.scrollHeight > node.clientHeight + 1 &&
          /(auto|scroll|overlay)/.test(overflowY);
        if (scrollable) return node;
        node = node.parentElement;
      }
      return null;
    }

    /**
     * Best-effort semantic type for a control, read from the DOM.
     *
     * The planner does not supply `semantic_type`, so anything that depends on
     * it (the country alias table in _normalizeFormOption) had to infer it from
     * the element. Name, id and the associated label text are the only signals
     * available in a sanitized observation.
     */
    _inferSemanticType(el, field = {}) {
      const declared = String(field.semantic_type || '').trim().toLowerCase();
      if (declared) return declared;
      const hints = [
        el?.getAttribute?.('name'),
        el?.getAttribute?.('id'),
        el?.getAttribute?.('aria-label'),
        el?.getAttribute?.('placeholder'),
        field.field_label
      ].filter((part) => typeof part === 'string' && part).join(' ');
      const haystack = hints.toLowerCase();
      if (/\b(country|nation)\b/.test(haystack)) return 'country';
      if (/\b(state|province|region)\b/.test(haystack)) return 'state';
      if (/\bgender|sex\b/.test(haystack)) return 'gender';
      return '';
    }

    _normalizeFormOption(value, semanticType = '') {
      let normalized = String(value ?? '').trim().toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ');
      if (semanticType === 'country') {
        const aliases = {
          us: 'united states', 'u s': 'united states', usa: 'united states',
          'u s a': 'united states', 'united states of america': 'united states',
          in: 'india', uk: 'united kingdom', 'u k': 'united kingdom',
          'great britain': 'united kingdom'
        };
        normalized = aliases[normalized] || normalized;
      }
      return normalized;
    }

    async _fillPlanElement(el, value, field = {}) {
      const str = String(this._normalizeDateForInput(el, value) ?? '');
      if (el.disabled || this._isReadOnlyControl(el)) throw new Error('Field is disabled or read-only.');
      el.scrollIntoView({ behavior: 'auto', block: 'center' });
      await this.sleep(80);
      el.focus();
      const tag = String(el.tagName || '').toUpperCase();
      const type = String(el.type || '').toLowerCase();
      const role = String(el.getAttribute?.('role') || '').toLowerCase();
      if (tag === 'SELECT') {
        // Infer the semantic type from the ELEMENT, not from the planner.
        // `field.semantic_type` is never populated on the planner path (the
        // documented field shape is {field_id, control_type, value|value_source}),
        // so reading it only meant the country alias map below was dead code and
        // `<option value="us">United States of America</option>` could never be
        // matched by a vault value of "United States".
        const semanticType = this._inferSemanticType(el, field);
        const normalize = candidate => this._normalizeFormOption(candidate, semanticType);
        const want = normalize(value);
        const options = Array.from(el.options || []);
        let opt = options.find(option => normalize(option.value) === want)
          || options.find(option => normalize(option.text) === want);
        if (!opt) {
          // Guarded substring fallback, mirroring _executeSelect: a stored
          // "United States" must resolve against "United States of America",
          // but only when the candidate unambiguously contains the wanted text.
          opt = options.find((option) => {
            const text = normalize(option.text);
            const val = normalize(option.value);
            return (text.length >= 4 && (text.includes(want) || val.includes(want)))
              || (want.length >= 4 && (want.includes(text) || want.includes(val)));
          });
        }
        if (!opt) throw new Error('No select option matches the configured profile value.');
        if (el.selectedIndex !== Array.from(el.options).indexOf(opt)) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
          if (setter) setter.call(el, opt.value);
          else el.value = opt.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          await this._waitForFieldSettle(el);
        }
      } else if (type === 'checkbox' || role === 'checkbox') {
        const should = this._checkboxValue(value);
        if (should === null) throw new Error('The configured checkbox value is ambiguous.');
        const current = role === 'checkbox' ? el.getAttribute('aria-checked') === 'true' : Boolean(el.checked);
        if (current !== should) {
          el.click();
          await this._waitForFieldSettle(el);
        }
        if (role === 'checkbox' && (el.getAttribute('aria-checked') === 'true') !== should) {
          throw new Error('The custom checkbox did not accept the requested state.');
        }
      } else if (type === 'radio') {
        const want = this._normalizeFormOption(value, field.semantic_type || '');
        const group = el.name
          ? Array.from(document.querySelectorAll('input[type="radio"]')).filter(radio => radio.name === el.name && radio.form === el.form)
          : [el];
        let matched = false;
        for (const r of group) {
          let lab = '';
          if (r.id) lab = document.querySelector(`label[for="${escapeIdForSelector(r.id)}"]`)?.innerText || '';
          if (!lab) lab = r.closest('label')?.innerText || '';
          if (this._normalizeFormOption(r.value, field.semantic_type || '') === want || this._normalizeFormOption(lab, field.semantic_type || '') === want) {
            matched = true;
            if (!r.checked && typeof r.click === 'function') r.click();
            break;
          }
        }
        if (!matched) throw new Error('No radio option matches the configured profile value.');
        await this._waitForFieldSettle(el);
      } else if (role === 'radio') {
        const groupRoot = el.closest?.('[role="radiogroup"]');
        if (!groupRoot) throw new Error('Custom radio controls need an accessible radiogroup to select safely.');
        const radios = Array.from(groupRoot.querySelectorAll?.('[role="radio"]') || []);
        const want = this._normalizeFormOption(value, field.semantic_type || '');
        const selected = radios.find((radio) => {
          const label = this._radioAccessibleText(radio);
          const optionValue = radio.getAttribute?.('value') || radio.getAttribute?.('aria-valuetext') || '';
          return this._normalizeFormOption(optionValue, field.semantic_type || '') === want ||
            this._normalizeFormOption(label, field.semantic_type || '') === want;
        });
        if (!selected) throw new Error('No custom radio option matches the configured profile value.');
        if (selected.getAttribute('aria-checked') !== 'true') selected.click();
        await this._waitForFieldSettle(selected);
        if (selected.getAttribute('aria-checked') !== 'true') throw new Error('The custom radio option did not become selected.');
      } else {
        if (type === 'file' || role === 'combobox') {
          throw new Error('This custom control cannot be safely filled as text.');
        }
        if (el.isContentEditable) {
          el.textContent = str;
        } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
          const prototype = tag === 'TEXTAREA' ? window.HTMLTextAreaElement?.prototype : window.HTMLInputElement?.prototype;
          const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (setter) setter.call(el, str);
          else el.value = str;
        } else if (role === 'textbox' && 'value' in el) {
          el.value = str;
        } else {
          throw new Error('This control does not expose a writable text value.');
        }
        this._dispatchValueEvents(el, str);
        await this._waitForFieldSettle(el);
      }
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      await this.sleep(40);
    }

    _checkboxValue(value) {
      const normalized = String(value ?? '').trim().toLowerCase();
      if (value === true || value === 1 || ['true', 'yes', '1', 'checked', 'agree', 'agreed', 'accepted', 'accept'].includes(normalized)) return true;
      if (value === false || value === 0 || ['false', 'no', '0', 'unchecked', 'decline', 'declined', 'not agree', ''].includes(normalized)) return false;
      return null;
    }

    _radioAccessibleText(radio) {
      const labelledBy = String(radio.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.innerText || '').join(' ');
      return radio.getAttribute?.('aria-label') || labelledBy || radio.innerText || radio.textContent || '';
    }

    _verifyPlanElement(el, value, field = {}) {
      const want = String(this._normalizeDateForInput(el, value) ?? '').toLowerCase();
      const tag = String(el.tagName || '').toUpperCase();
      const type = String(el.type || '').toLowerCase();
      const role = String(el.getAttribute?.('role') || '').toLowerCase();
      if (tag === 'SELECT') {
        const expected = this._normalizeFormOption(value, field.semantic_type || '');
        const selected = el.options[el.selectedIndex];
        return Boolean(selected) && selected.selected === true && (
          this._normalizeFormOption(el.value, field.semantic_type || '') === expected ||
          this._normalizeFormOption(selected.text, field.semantic_type || '') === expected
        );
      }
      if (type === 'checkbox' || role === 'checkbox') {
        const should = this._checkboxValue(value);
        if (should === null) return false;
        return role === 'checkbox'
          ? (el.getAttribute('aria-checked') === 'true') === should
          : el.checked === should;
      }
      if (type === 'radio') {
        const group = el.name
          ? Array.from(document.querySelectorAll('input[type="radio"]')).filter(radio => radio.name === el.name && radio.form === el.form)
          : [el];
        const expected = this._normalizeFormOption(value, field.semantic_type || '');
        for (const r of group) {
          let lab = '';
          if (r.id) lab = document.querySelector(`label[for="${escapeIdForSelector(r.id)}"]`)?.innerText || '';
          if (!lab) lab = r.closest('label')?.innerText || '';
          const matches = this._normalizeFormOption(r.value, field.semantic_type || '') === expected || this._normalizeFormOption(lab, field.semantic_type || '') === expected;
          if (matches) return r.checked === true;
        }
        return false;
      }
      if (role === 'radio') {
        const groupRoot = el.closest?.('[role="radiogroup"]');
        if (!groupRoot) return false;
        const expected = this._normalizeFormOption(value, field.semantic_type || '');
        return Array.from(groupRoot.querySelectorAll?.('[role="radio"]') || []).some((radio) => {
          const optionValue = radio.getAttribute?.('value') || radio.getAttribute?.('aria-valuetext') || '';
          const matches = this._normalizeFormOption(optionValue, field.semantic_type || '') === expected ||
            this._normalizeFormOption(this._radioAccessibleText(radio), field.semantic_type || '') === expected;
          return matches && radio.getAttribute('aria-checked') === 'true';
        });
      }
      if (el.isContentEditable) return String(el.textContent || '').toLowerCase() === want;
      if (role === 'textbox' && !('value' in el)) return false;
      return String(el.value ?? '').toLowerCase() === want;
    }

    async _executePressKey(element, actionPayload) {
      const key = String(actionPayload.resolvedValue || actionPayload.value || 'Enter');
      const target = element || document.activeElement || document.body;
      const lowerKey = key.toLowerCase();
      const isEnter = lowerKey === 'enter' || key === '13';
      const isEscape = lowerKey === 'escape' || lowerKey === 'esc' || key === '27';
      const isTab = lowerKey === 'tab' || key === '9';
      const isSpace = lowerKey === 'space' || key === ' ';

      let keyCode = 0;
      let code = key;
      if (isEnter) { keyCode = 13; code = 'Enter'; }
      else if (isEscape) { keyCode = 27; code = 'Escape'; }
      else if (isTab) { keyCode = 9; code = 'Tab'; }
      else if (isSpace) { keyCode = 32; code = 'Space'; }
      else if (key.length === 1) { keyCode = key.charCodeAt(0); }

      const eventInit = {
        bubbles: true,
        cancelable: true,
        key: isEnter ? 'Enter' : key,
        code,
        keyCode,
        which: keyCode
      };

      target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
      target.dispatchEvent(new KeyboardEvent('keyup', eventInit));

      if (isEnter) {
        // Synthetic KeyboardEvent does not trigger native form submission in Chromium.
        // Explicitly trigger form submission or click the search/submit button.
        const form = target.form || target.closest?.('form');
        let submitted = false;
        if (form) {
          try {
            if (typeof form.requestSubmit === 'function') {
              form.requestSubmit();
              submitted = true;
            }
          } catch {
            // requestSubmit might throw if form validation fails or submit button is disabled
          }
          if (!submitted) {
            const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button#search-icon-legacy, [aria-label*="Search" i]');
            if (submitBtn && typeof submitBtn.click === 'function') {
              submitBtn.click();
              submitted = true;
            } else {
              try { form.submit(); submitted = true; } catch {}
            }
          }
        }
        if (!submitted) {
          // Check for nearby search button (common on single-page apps like YouTube)
          const nearbySubmit = target.parentElement?.querySelector?.('button#search-icon-legacy, button[aria-label*="Search" i]') ||
            document.querySelector('button#search-icon-legacy, ytd-searchbox button#search-icon-legacy');
          if (nearbySubmit && typeof nearbySubmit.click === 'function') {
            nearbySubmit.click();
          }
        }
      }
      return { success: true };
    }

    sleep(ms) {
      return new Promise(r => setTimeout(r, ms));
    }

    /**
     * Frameworks react to SELECT/RADIO state changes asynchronously
     * (dependent dropdowns, revealed sections). Wait for the DOM to settle —
     * 150ms of quiet, hard-capped at 500ms — before the next field.
     */
    async _waitForFieldSettle(el) {
      // A non-form control (a clicked button, a menu item) is not waiting on a
      // dependent dropdown, and observing it was actively harmful: with no form
      // the scope collapsed to parentElement, and when the click had already
      // removed the element that was null, so the scope became document.body
      // -- an unfiltered subtree observer over the whole page that never goes
      // quiet on an SPA. That cost the full 500ms cap on every such click and
      // multiplied Blink's per-mutation cost page-wide.
      const tag = String(el?.tagName || '').toUpperCase();
      const isField = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el?.isContentEditable === true;
      if (!isField) {
        await this.sleep(120);
        return;
      }
      const scope = el?.form || el?.closest?.('form') || el?.parentElement || null;
      if (typeof MutationObserver === 'undefined' || !scope) {
        await this.sleep(300);
        return;
      }
      await new Promise((resolve) => {
        let hardTimer = null;
        let quietTimer = null;
        let observer = null;
        const finish = () => {
          if (hardTimer) clearTimeout(hardTimer);
          if (quietTimer) clearTimeout(quietTimer);
          try { observer?.disconnect(); } catch { /* already disconnected */ }
          resolve();
        };
        observer = new MutationObserver(() => {
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(finish, 150); // settled after a quiet window
        });
        try {
          // Same attribute filter as the page-stability observer, so the two
          // notions of "settled" cannot disagree.
          observer.observe(scope, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: OBSERVED_ATTRIBUTES
          });
        } catch {
          finish();
          return;
        }
        quietTimer = setTimeout(finish, 150);
        hardTimer = setTimeout(finish, 500); // bounded: never stall the plan
      });
    }
  }

  const executor = new BrowserExecutor();

  // Single in-flight guard over the two registry-mutating operations.
  let activeOperation = null;

  // 6. Runtime Message Listener
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Validate the shape before destructuring: a null or non-object message
    // used to throw a TypeError inside the listener itself.
    const type = message && typeof message === 'object' ? message.type : undefined;
    const payload = message && typeof message === 'object' ? message.payload : undefined;

    const senderUrl = (() => { try { return new URL(sender?.url || ''); } catch { return null; } })();
    const trustedBackground = sender?.id === chrome.runtime.id && !sender?.tab &&
      (!senderUrl || ['chrome-extension:', 'moz-extension:'].includes(senderUrl.protocol));
    if (!trustedBackground) {
      sendResponse({ success: false, error: 'Untrusted extension message sender.' });
      return false;
    }

    // EXTRACT_DOM and EXECUTE_ACTION both mutate the shared element registry:
    // extraction clears and renumbers it. They used to run concurrently with no
    // coordination, so an extraction landing partway through a form plan
    // renumbered the ids the running plan was still resolving. Serialize them
    // and refuse rather than interleave.
    if (type === MessageType.EXTRACT_DOM || type === MessageType.EXECUTE_ACTION) {
      if (activeOperation) {
        sendResponse({
          success: false,
          error: `Another ${activeOperation.type === MessageType.EXTRACT_DOM ? 'page observation' : 'page action'} is still running.`
        });
        return false;
      }
    }

    switch (type) {
      case MessageType.EXTRACT_DOM:
        activeOperation = { type };
        stabilityObserver.waitForStability(200, 1000).then(() => {
          const domData = domExtractor.extractPageElements();
          activeOperation = null;
          sendResponse({ success: true, data: domData });
        }).catch(err => {
          activeOperation = null;
          // The caller only ever saw { success: false, error }, which the
          // background then folded into a generic friendly message. Without
          // this line the underlying cause was unrecoverable after the fact.
          log.exception('Content', 'EXTRACT_DOM failed', err);
          sendResponse({ success: false, error: err.message });
        });
        return true; // Keep message channel open for async response

      case MessageType.EXECUTE_ACTION:
        activeOperation = { type };
        executor.execute(payload).then(result => {
          activeOperation = null;
          sendResponse(result);
        }).catch(err => {
          activeOperation = null;
          log.exception('Content', 'EXECUTE_ACTION failed', err, { action: payload?.action?.action ?? null });
          sendResponse({ success: false, error: err.message });
        });
        return true;

      case MessageType.CLEAR_OVERLAYS:
        visualOverlay.clear();
        sendResponse({ success: true });
        break;

      case MessageType.CHECK_PAGE_STABILITY:
        stabilityObserver.waitForStability(payload?.quietMs || 300, 2000).then(() => {
          sendResponse({ stable: true });
        }).catch(err => {
          log.exception('Content', 'CHECK_PAGE_STABILITY failed', err);
          sendResponse({ stable: false, error: err.message });
        });
        return true;

      default:
        break;
    }
  });

  // The listener is live, so the tab is genuinely initialized. Claiming this
  // earlier would make any failure above unrecoverable.
  markInitialized();
})();
