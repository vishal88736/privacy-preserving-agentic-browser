/**
 * Privacy-Preserving Agentic Browser - Content Script
 * Self-contained for Chrome Manifest V3 isolated world execution.
 * Handles DOM perception, visual overlays, physical action execution, and page stability.
 */

(() => {
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

  console.log('[PrivacyAgent] Content script initialized.');

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
    HIGHLIGHT_ELEMENT: 'HIGHLIGHT_ELEMENT',
    SHOW_VISUAL_CURSOR: 'SHOW_VISUAL_CURSOR',
    CLEAR_OVERLAYS: 'CLEAR_OVERLAYS',
    CHECK_PAGE_STABILITY: 'CHECK_PAGE_STABILITY'
  };

  // 1. Element Registry
  class ElementRegistry {
    constructor() {
      this.idToElement = new Map();
      this.elementToId = new WeakMap();
      this.counter = 1;
    }

    clear() {
      this.idToElement.clear();
      // WeakMap has no .clear(): allocate a fresh one, otherwise re-extracted
      // identical nodes resolve to stale ids that are absent from idToElement
      // and every lookup after the first extraction returns null.
      this.elementToId = new WeakMap();
      this.counter = 1;
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
  }

  const registry = new ElementRegistry();

  // Escape ids for use inside attribute selectors: element ids may contain
  // colons, dots, or brackets that would otherwise break (or worse, inject
  // into) the selector. CSS.escape is not available in all runtimes (Node
  // test environments), so fall back to a conservative escape.
  function escapeIdForSelector(id) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(id));
    return String(id).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // 2. DOM Extractor — interactive controls PLUS page evidence (cards, prices, headings, text)
  class DOMExtractor {
    getAccessibleLabel(element) {
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelEl = document.getElementById(labelledBy);
        if (labelEl) return labelEl.innerText.trim();
      }

      const ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim();

      if (element.id) {
        const label = document.querySelector(`label[for="${escapeIdForSelector(element.id)}"]`);
        if (label) return label.innerText.trim();
      }

      const parentLabel = element.closest('label');
      if (parentLabel) {
        return parentLabel.innerText.trim();
      }

      if (element.placeholder) return element.placeholder.trim();
      if (element.title) return element.title.trim();
      if (element.name) return element.name.trim();

      if (element.innerText && element.innerText.trim()) {
        return element.innerText.trim().slice(0, 80);
      }

      return '';
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

    getContextText(node) {
      const container = node.closest('article, li, tr, form, fieldset, [role="listitem"], [class*="card"], [class*="product"], [class*="result"], [class*="item"], [class*="flight"], [class*="listing"], [data-product], [data-asin]') || node.parentElement;
      if (!container) return '';
      return String(container.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 280);
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

      try {
        const allElements = root.querySelectorAll('*');
        for (let i = 0; i < allElements.length; i++) {
          const shadow = allElements[i]?.shadowRoot;
          if (shadow) {
            matches = matches.concat(this.queryAllDeep(selector, shadow));
          }
        }
      } catch {}

      return matches;
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
      // Prioritized passes: form controls first, then buttons, then links —
      // so form fields are never dropped on complex pages even at the cap.
      // DOM order within each pass is preserved.
      const passes = [
        'input, select, textarea, [role="textbox"], [role="checkbox"]',
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

      for (const node of rawNodes) {
        const rect = node.getBoundingClientRect();
        const isVisible = this.isElementVisible(node, rect);

        if (!isVisible && node.type !== 'file') continue;
        if (extracted.length >= MAX_ELEMENTS) break;

        const id = registry.register(node);
        const tag = node.tagName.toLowerCase();
        const label = this.getAccessibleLabel(node);
        const context = this.getContextText(node);
        const price_value = this.parsePrice(`${label} ${context}`);
        const describedBy = String(node.getAttribute('aria-describedby') || '').split(/\s+/)
          .map((id) => document.getElementById(id)?.innerText || '')
          .filter(Boolean).join(' ').slice(0, 500);
        const fieldsetLegend = node.closest('fieldset')?.querySelector('legend')?.innerText?.trim()?.slice(0, 240) || '';

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
          tag,
          type: node.type || '',
          name: node.name || '',
          label,
          accessible_name: label,
          placeholder: node.placeholder || '',
          value: node.value || '',
          autocomplete: node.autocomplete || '',
          ariaLabel: node.getAttribute('aria-label') || '',
          ariaDescribedBy: describedBy,
          fieldset_legend: fieldsetLegend,
          role: node.getAttribute('role') || '',
          href: node.getAttribute('href') || '',
          disabled: Boolean(node.disabled),
          in_form: Boolean(node.form),
          form_id: node.form?.id || null,
          // Required-ness drives whether a field gets a vault value at all. A
          // page can mark any field required, so this is treated as a planning
          // hint and never as authorisation on its own — but without it the
          // agent cannot tell "the form cannot be submitted without this" from
          // "there is an optional marketing field here".
          required: Boolean(node.required || node.getAttribute('aria-required') === 'true'),
          checked: Boolean(node.checked),
          context,
          price_value,
          options,
          bbox: this.bboxOf(rect),
          is_interactive: true,
          is_visible: isVisible
        });
      }

      const main = document.querySelector('main, [role="main"], #content, .content') || document.body;
      const visible_text = String(main?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);

      return {
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
        // Only a rendered, in-viewport canvas/video surface can contain
        // pixels that OCR cannot audit. Invisible analytics-pixel canvases
        // (common on modern pages) must not gut visual grounding for every
        // observation on the page.
        opaqueVisualSurface: this._hasOpaqueVisualSurface(),
        elements: extracted
      };
    }

    _hasOpaqueVisualSurface() {
      for (const el of document.querySelectorAll('canvas, video, iframe')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && this.isElementVisible(el, rect)) return true;
      }
      return false;
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
      this.observer = null;
      this._startObserving();
    }

    _startObserving() {
      if (typeof MutationObserver === 'undefined') return;
      const target = (typeof document !== 'undefined') ? (document.body || document.documentElement) : null;
      if (!target) {
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('DOMContentLoaded', () => this._startObserving(), { once: true });
        }
        return;
      }
      if (this.observer) {
        try { this.observer.disconnect(); } catch {}
      }
      this.observer = new MutationObserver(() => {
        this.lastMutationTime = Date.now();
      });
      try {
        this.observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
      } catch {}
    }

    markAction() {
      this.lastMutationTime = Date.now();
    }

    async waitForStability(quietMs = 120, timeoutMs = 1500) {
      if (!this.observer) this._startObserving();
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        if (Date.now() - this.lastMutationTime >= quietMs) {
          return true;
        }
        await new Promise(r => setTimeout(r, 25));
      }
      return true;
    }
  }

  const stabilityObserver = new PageStabilityObserver();

  // 5. Browser Action Executor
  class BrowserExecutor {
    async execute(actionPayload) {
      const { action, target, resolvedValue, coordinates } = actionPayload;

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
            // Already in the desired state: do not re-notify framework
            // listeners with a synthetic change event.
            if (targetElement.checked) return { success: true, changed: false };
            if (typeof targetElement.click === 'function') targetElement.click();
            else { targetElement.checked = true; targetElement.dispatchEvent(new Event('change', { bubbles: true })); }
          }
          return { success: true };

        case 'UNCHECK':
          if (targetElement) {
            if (!targetElement.checked) return { success: true, changed: false };
            if (typeof targetElement.click === 'function') targetElement.click();
            else { targetElement.checked = false; targetElement.dispatchEvent(new Event('change', { bubbles: true })); }
          }
          return { success: true };

        case 'SCROLL':
          window.scrollBy({ left: actionPayload.deltaX || 0, top: actionPayload.deltaY || 300, behavior: 'smooth' });
          await this.sleep(250);
          return { success: true };

        case 'UPLOAD':
          return this._executeUpload(targetElement, resolvedValue);

        case 'SUBMIT':
          return this._executeSubmit(targetElement);

        case 'FILL_FORM_PLAN': {
          const plan = resolvedValue?.fields ? resolvedValue : resolvedValue?.value?.fields ? resolvedValue.value : actionPayload.value?.fields ? actionPayload.value : null;
          return this._executeFormPlan(plan);
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
        element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        element.click();
        return { success: true };
      }

      if (coords && coords.length === 2) {
        const el = document.elementFromPoint(coords[0], coords[1]);
        if (el) {
          el.click();
          return { success: true };
        }
      }

      throw new Error('Target click element not found');
    }

    async _executeType(element, text) {
      if (!element) throw new Error('Target type element not found');
      
      if (element.type === 'file' || (typeof text === 'object' && text !== null)) {
        return this._executeUpload(element, text);
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

      element.focus();
      element.value = '';
      element.dispatchEvent(new Event('input', { bubbles: true }));

      const tag = String(element.tagName || '').toUpperCase();
      try {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter && (tag === 'INPUT' || tag === 'TEXTAREA')) {
          setter.call(element, valueToSet);
        } else {
          element.value = valueToSet;
        }
      } catch {
        element.value = valueToSet;
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: valueToSet }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      // No synthetic Enter keyup here: pages with keyup-Enter submit handlers
      // (chats, search bars) would submit prematurely during a typing step.

      // Verify rather than report unconditional success.
      //
      // The native value setter bypasses the browser's own constraints, so two
      // distinct failures have to be checked explicitly:
      //  - maxlength is not enforced by the IDL setter, so an OTP field can
      //    "accept" 20 characters a human could never type; the server then
      //    rejects it and the whole task fails at the worst moment.
      //  - an unparseable value silently yields '' on a type=number/date field,
      //    so the write appears to succeed while the field is empty.
      const maxlength = element.getAttribute?.('maxlength');
      if (maxlength && Number.isFinite(Number(maxlength)) && valueToSet.length > Number(maxlength)) {
        return {
          success: false,
          error: `Value is ${valueToSet.length} characters but the field accepts at most ${maxlength}.`
        };
      }
      if (String(element.value ?? '') !== valueToSet) {
        return { success: false, error: 'The field rejected the value (wrong format for this input type).' };
      }
      return { success: true };
    }

    async _executeSelect(element, optionValue) {
      if (!element) throw new Error('Target select element not found');
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
        return { success: false, error: `No option on this dropdown matches "${optionValue}".` };
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
      
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      if (element.selectedIndex < 0) {
        return { success: false, error: 'The dropdown did not accept the option.' };
      }
      return { success: true };
    }

    async _executeUpload(element, docData) {
      if (!element) throw new Error('Target upload element not found');

      if (docData?.demo !== true || docData?.content !== 'SYNTHETIC DEMO FILE — NO PERSONAL DATA') {
        throw new Error('Real document upload is not supported. Choose the file directly on the webpage.');
      }
      const fileName = 'synthetic-demo.txt';
      const mimeType = 'text/plain';
      const fileContent = docData.content;

      const blob = new Blob([fileContent], { type: mimeType });
      const file = new File([blob], fileName, { type: mimeType });

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      element.files = dataTransfer.files;

      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('input', { bubbles: true }));

      return { success: true, uploadedFile: fileName };
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
    async _executeFormPlan(plan) {
      const fields = plan?.fields || [];
      if (!fields.length) throw new Error('Form plan has no fields to fill');
      const details = [];

      // Phase 1: resolve every target up front, while ids still mean something.
      const resolved = fields.map((field) => {
        if (field.value === undefined || field.value === null || field.value === '') {
          return { field, el: null, reason: `Missing value for "${field.field_id}" (${field.value_source || 'no source'})` };
        }
        const el = field.field_id ? registry.getElement(field.field_id) : null;
        if (!el) return { field, el: null, reason: 'Element not found (page changed since observation)' };
        if (!el.isConnected) return { field, el: null, reason: 'Element was removed from the page' };
        // The plan was built against an observation. If the control has become
        // something else, the value does not belong in it — a card number must
        // never follow a field that turned into a search box.
        const expected = String(field.control_type || '').toUpperCase();
        if (expected && this._controlTypeOf(el) !== expected) {
          return { field, el: null, reason: `Field type changed (expected ${expected}, found ${this._controlTypeOf(el)})` };
        }
        return { field, el, reason: null };
      });

      // Phase 2: fill, reusing the references captured above.
      for (const item of resolved) {
        if (!item.el) {
          details.push({ field: item.field.field_id, success: false, reason: item.reason });
          continue;
        }
        const { field, el } = item;
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

    /** DOM-level control kind, matching FormAnalyzer.controlType() values. */
    _controlTypeOf(el) {
      const tag = String(el?.tagName || '').toLowerCase();
      const type = String(el?.type || '').toLowerCase();
      if (tag === 'select') return 'SELECT';
      if (tag === 'textarea') return 'TEXTAREA';
      if (type === 'radio') return 'RADIO';
      if (type === 'checkbox') return 'CHECKBOX';
      if (type === 'email') return 'EMAIL';
      if (type === 'tel') return 'PHONE';
      if (type === 'number') return 'NUMBER';
      if (type === 'date') return 'DATE';
      return 'TEXT';
    }

    _normalizeDateForInput(el, value) {
      try {
        const type = String(el?.type || '').toLowerCase();
        if (type !== 'date' || typeof value !== 'string') return value;
        const trimmed = value.trim();
        if (!trimmed) return '';
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
      el.scrollIntoView({ behavior: 'auto', block: 'center' });
      await this.sleep(80);
      el.focus();
      const tag = String(el.tagName || '').toUpperCase();
      const type = String(el.type || '').toLowerCase();
      if (tag === 'SELECT') {
        const semanticType = field.semantic_type || '';
        const normalize = candidate => this._normalizeFormOption(candidate, semanticType);
        const want = normalize(value);
        const opt = Array.from(el.options || []).find(option => normalize(option.value) === want)
          || Array.from(el.options || []).find(option => normalize(option.text) === want);
        if (!opt) throw new Error('No select option matches the configured profile value.');
        if (el.selectedIndex !== Array.from(el.options).indexOf(opt)) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
          if (setter) setter.call(el, opt.value);
          else el.value = opt.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          await this._waitForFieldSettle(el);
        }
      } else if (type === 'checkbox') {
        const normalized = String(value ?? '').trim().toLowerCase();
        let should;
        if (value === true || value === 1 || ['true', 'yes', '1', 'checked', 'agree', 'agreed', 'accepted', 'accept'].includes(normalized)) should = true;
        else if (value === false || value === 0 || ['false', 'no', '0', 'unchecked', 'decline', 'declined', 'not agree', ''].includes(normalized)) should = false;
        else throw new Error('The configured checkbox value is ambiguous.');
        if (el.checked !== should) el.click();
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
      } else {
        try {
          const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter && (tag === 'INPUT' || tag === 'TEXTAREA')) setter.call(el, str);
          else el.value = str;
        } catch { el.value = str; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      await this.sleep(40);
    }

    _verifyPlanElement(el, value, field = {}) {
      const want = String(this._normalizeDateForInput(el, value) ?? '').toLowerCase();
      const tag = String(el.tagName || '').toUpperCase();
      const type = String(el.type || '').toLowerCase();
      if (tag === 'SELECT') {
        const expected = this._normalizeFormOption(value, field.semantic_type || '');
        const selected = el.options[el.selectedIndex];
        return Boolean(selected) && selected.selected === true && (
          this._normalizeFormOption(el.value, field.semantic_type || '') === expected ||
          this._normalizeFormOption(selected.text, field.semantic_type || '') === expected
        );
      }
      if (type === 'checkbox') {
        const normalized = String(value ?? '').trim().toLowerCase();
        const should = value === true || value === 1 || ['true', 'yes', '1', 'checked', 'agree', 'agreed', 'accepted', 'accept'].includes(normalized);
        return el.checked === should;
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
      return String(el.value ?? '').toLowerCase() === want;
    }

    async _executePressKey(element, actionPayload) {
      const key = actionPayload.resolvedValue || actionPayload.value || 'Enter';
      const target = element || document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: String(key) }));
      target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: String(key) }));
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
      const scope = el?.form || el?.closest('form') || el?.parentElement || document.body;
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
          observer.observe(scope, { childList: true, subtree: true, attributes: true });
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
          sendResponse({ success: false, error: err.message });
        });
        return true;

      case MessageType.HIGHLIGHT_ELEMENT:
        if (payload?.element_id) {
          const el = registry.getElement(payload.element_id);
          if (el) visualOverlay.highlightElement(el);
        }
        sendResponse({ success: true });
        break;

      case MessageType.CLEAR_OVERLAYS:
        visualOverlay.clear();
        sendResponse({ success: true });
        break;

      case MessageType.CHECK_PAGE_STABILITY:
        stabilityObserver.waitForStability(payload?.quietMs || 300, 2000).then(() => {
          sendResponse({ stable: true });
        }).catch(err => {
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
