/**
 * Privacy-Preserving Agentic Browser - Content Script
 * Self-contained for Chrome Manifest V3 isolated world execution.
 * Handles DOM perception, visual overlays, physical action execution, and page stability.
 */

(() => {
  // Prevent multiple injections
  if (window.__PRIVACY_AGENT_CONTENT_INITIALIZED__) return;
  window.__PRIVACY_AGENT_CONTENT_INITIALIZED__ = true;

  console.log('[PrivacyAgent] Content script initialized in', window.location.href);

  // Message Types
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
        const label = document.querySelector(`label[for="${element.id}"]`);
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

    extractHeadings() {
      const out = [];
      for (const h of document.querySelectorAll('h1, h2, h3, [role="heading"]')) {
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
      try { nodes = Array.from(document.querySelectorAll(selectors)); } catch { nodes = []; }

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
      const selector = 'input, button, a, select, textarea, [role="button"], [role="textbox"], [role="checkbox"], [role="option"], [role="link"], [tabindex]:not([tabindex="-1"])';
      const rawNodes = Array.from(document.querySelectorAll(selector));

      const extracted = [];

      for (const node of rawNodes) {
        const rect = node.getBoundingClientRect();
        const isVisible = this.isElementVisible(node, rect);

        if (!isVisible && node.type !== 'file') continue;
        if (extracted.length >= 80) break;

        const id = registry.register(node);
        const tag = node.tagName.toLowerCase();
        const label = this.getAccessibleLabel(node);
        const context = this.getContextText(node);
        const price_value = this.parsePrice(`${label} ${context}`);

        extracted.push({
          id,
          tag,
          type: node.type || '',
          name: node.name || '',
          label,
          placeholder: node.placeholder || '',
          value: node.value || '',
          autocomplete: node.autocomplete || '',
          ariaLabel: node.getAttribute('aria-label') || '',
          role: node.getAttribute('role') || '',
          href: node.getAttribute('href') || '',
          disabled: Boolean(node.disabled),
          in_form: Boolean(node.form),
          checked: Boolean(node.checked),
          context,
          price_value,
          options: tag === 'select'
            ? Array.from(node.options || []).slice(0, 20).map((o) => String(o.text || o.value || '').trim()).filter(Boolean)
            : undefined,
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
          height: window.innerHeight
        },
        scroll: {
          x: Math.round(window.scrollX || 0),
          y: Math.round(window.scrollY || 0),
          maxY: Math.round(document.documentElement.scrollHeight || 0)
        },
        headings: this.extractHeadings(),
        result_items: this.extractResultItems(extracted),
        visible_text,
        elements: extracted
      };
    }
  }

  const domExtractor = new DOMExtractor();

  // 3. Visual Overlay
  class VisualOverlay {
    constructor() {
      this.cursorEl = null;
      this.highlightEl = null;
      this._clearTimer = null;
      this._reducedMotion = typeof window !== 'undefined' && window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this._ensureElements();
    }

    _ensureElements() {
      if (!document.getElementById('privacy-agent-cursor')) {
        const cursor = document.createElement('div');
        cursor.id = 'privacy-agent-cursor';
        cursor.style.cssText = `
          position: fixed;
          width: 22px;
          height: 22px;
          background: radial-gradient(circle, rgba(99,102,241,0.9) 0%, rgba(79,70,229,0.5) 70%, transparent 100%);
          border: 2px solid #ffffff;
          border-radius: 50%;
          pointer-events: none;
          z-index: 2147483647;
          transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.2s ease;
          box-shadow: 0 0 12px rgba(99, 102, 241, 0.8);
          opacity: 0;
          transform: translate(-50%, -50%);
        `;
        document.documentElement.appendChild(cursor);
        this.cursorEl = cursor;
      } else {
        this.cursorEl = document.getElementById('privacy-agent-cursor');
      }

      if (!document.getElementById('privacy-agent-highlight')) {
        const highlight = document.createElement('div');
        highlight.id = 'privacy-agent-highlight';
        highlight.style.cssText = `
          position: absolute;
          border: 2px solid #6366f1;
          background: rgba(99, 102, 241, 0.12);
          border-radius: 6px;
          pointer-events: none;
          z-index: 2147483646;
          transition: all 0.2s ease;
          opacity: 0;
          box-shadow: 0 0 8px rgba(99, 102, 241, 0.4);
        `;
        document.documentElement.appendChild(highlight);
        this.highlightEl = highlight;
      } else {
        this.highlightEl = document.getElementById('privacy-agent-highlight');
      }
    }

    showCursor(x, y) {
      this._ensureElements();
      if (this.cursorEl) {
        this.cursorEl.style.left = `${x}px`;
        this.cursorEl.style.top = `${y}px`;
        this.cursorEl.style.opacity = '1';
      }
    }

    highlightElement(element) {
      this._ensureElements();
      if (!element || !this.highlightEl) return;
      const rect = element.getBoundingClientRect();
      const scrollX = window.scrollX || window.pageXOffset;
      const scrollY = window.scrollY || window.pageYOffset;

      this.highlightEl.style.left = `${rect.left + scrollX - 3}px`;
      this.highlightEl.style.top = `${rect.top + scrollY - 3}px`;
      this.highlightEl.style.width = `${rect.width + 6}px`;
      this.highlightEl.style.height = `${rect.height + 6}px`;
      this.highlightEl.style.opacity = '1';

      this.showCursor(rect.left + rect.width / 2, rect.top + rect.height / 2);

      // Auto-clear so the page is never permanently modified
      if (this._clearTimer) clearTimeout(this._clearTimer);
      this._clearTimer = setTimeout(() => this.clear(), 1800);
    }

    clear() {
      if (this._clearTimer) { clearTimeout(this._clearTimer); this._clearTimer = null; }
      if (this.cursorEl) this.cursorEl.style.opacity = '0';
      if (this.highlightEl) this.highlightEl.style.opacity = '0';
    }
  }

  const visualOverlay = new VisualOverlay();

  // 4. Page Stability Observer
  class PageStabilityObserver {
    constructor() {
      this.lastMutationTime = Date.now();
      if (document.body) {
        this.observer = new MutationObserver(() => {
          this.lastMutationTime = Date.now();
        });
        this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      }
    }

    async waitForStability(quietMs = 300, timeoutMs = 2500) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        if (Date.now() - this.lastMutationTime >= quietMs) {
          return true;
        }
        await new Promise(r => setTimeout(r, 50));
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
      }

      if (!targetElement && coordinates && coordinates.length === 2) {
        targetElement = document.elementFromPoint(coordinates[0], coordinates[1]);
      }

      if (targetElement) {
        const smoothOk = !(typeof window !== 'undefined' && window.matchMedia &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        targetElement.scrollIntoView({ behavior: smoothOk ? 'smooth' : 'auto', block: 'center', inline: 'nearest' });
        visualOverlay.highlightElement(targetElement);
        await this.sleep(150);
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
            if (!targetElement.checked && typeof targetElement.click === 'function') targetElement.click();
            else { targetElement.checked = true; targetElement.dispatchEvent(new Event('change', { bubbles: true })); }
          }
          return { success: true };

        case 'UNCHECK':
          if (targetElement) {
            if (targetElement.checked && typeof targetElement.click === 'function') targetElement.click();
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

        case 'OPEN_TAB':
        case 'SWITCH_TAB': {
          const url = target?.url || resolvedValue || actionPayload.value;
          if (url && typeof url === 'string' && /^https?:\/\//i.test(url)) {
            window.open(url, '_blank');
            return { success: true, openedUrl: url };
          }
          return { success: false, error: `${action} needs a valid http(s) URL; use NAVIGATE for same-tab navigation.` };
        }

        case 'WAIT':
          await this.sleep(actionPayload.duration || 1000);
          return { success: true };

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
          if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
            const m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
            if (m) rawText = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
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
      element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));

      return { success: true };
    }

    async _executeSelect(element, optionValue) {
      if (!element) throw new Error('Target select element not found');
      element.focus();
      const str = String(optionValue ?? '').toLowerCase();
      const opt = Array.from(element.options).find(o =>
        String(o.value ?? '').toLowerCase() === str ||
        String(o.text ?? '').toLowerCase().includes(str)
      );
      
      const valueToSet = opt ? opt.value : optionValue;
      
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
      return { success: true };
    }

    async _executeUpload(element, docData) {
      if (!element) throw new Error('Target upload element not found');

      const fileName = docData?.name || 'Aadhaar_Card.pdf';
      const mimeType = docData?.type || 'application/pdf';
      const fileContent = docData?.content || 'Dummy PDF content';

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

    async _executeFormPlan(plan) {
      const fields = plan?.fields || [];
      if (!fields.length) throw new Error('Form plan has no fields to fill');
      const details = [];
      for (const field of fields) {
        if (field.value === undefined || field.value === null || field.value === '') {
          details.push({ field: field.field_id, success: false, reason: `Missing value for "${field.field_id}" (${field.value_source || 'no source'})` });
          continue;
        }
        let el = field.field_id ? registry.getElement(field.field_id) : null;
        if (!el && field.field_id) {
          el = document.getElementById(field.field_id)
            || (() => { try { return document.querySelector(`[name="${field.field_id}"]`); } catch { return null; } })();
        }
        if (!el) {
          details.push({ field: field.field_id, success: false, reason: 'Element not found' });
          continue;
        }
        try {
          await this._fillPlanElement(el, field.value);
          const ok = this._verifyPlanElement(el, field.value);
          details.push({ field: field.field_id, success: ok, ...(ok ? {} : { reason: 'Verification failed: value mismatch' }) });
        } catch (e) {
          details.push({ field: field.field_id, success: false, reason: e.message });
        }
      }
      return { success: details.length > 0 && details.every(r => r.success), details };
    }

    _normalizeDateForInput(el, value) {
      try {
        const type = String(el?.type || '').toLowerCase();
        if (type !== 'date' || typeof value !== 'string') return value;
        if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
        const m = String(value).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
        if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      } catch { /* fall through with original value */ }
      return value;
    }

    async _fillPlanElement(el, value) {
      const str = String(this._normalizeDateForInput(el, value) ?? '');
      el.scrollIntoView({ behavior: 'auto', block: 'center' });
      await this.sleep(80);
      el.focus();
      const tag = String(el.tagName || '').toUpperCase();
      const type = String(el.type || '').toLowerCase();
      if (tag === 'SELECT') {
        const want = str.toLowerCase();
        const opt = Array.from(el.options).find(o =>
          String(o.value ?? '').toLowerCase() === want ||
          String(o.text ?? '').toLowerCase().includes(want));
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
      } else if (type === 'checkbox') {
        const should = value === true || value === 'true' || value === 'yes';
        if (el.checked !== should && typeof el.click === 'function') el.click();
        else { el.checked = should; el.dispatchEvent(new Event('change', { bubbles: true })); }
      } else if (type === 'radio') {
        const want = str.toLowerCase();
        const group = el.name ? document.querySelectorAll(`input[type="radio"][name="${el.name}"]`) : [el];
        for (const r of group) {
          let lab = '';
          if (r.id) lab = document.querySelector(`label[for="${r.id}"]`)?.innerText || '';
          if (!lab) lab = r.closest('label')?.innerText || '';
          if (String(r.value ?? '').toLowerCase() === want || String(lab ?? '').toLowerCase().includes(want)) {
            if (!r.checked && typeof r.click === 'function') r.click();
            break;
          }
        }
      } else {
        try {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter && (tag === 'INPUT' || tag === 'TEXTAREA')) setter.call(el, str);
          else el.value = str;
        } catch { el.value = str; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      await this.sleep(40);
    }

    _verifyPlanElement(el, value) {
      const want = String(this._normalizeDateForInput(el, value) ?? '').toLowerCase();
      const tag = String(el.tagName || '').toUpperCase();
      const type = String(el.type || '').toLowerCase();
      if (tag === 'SELECT') {
        const sel = el.options[el.selectedIndex]?.text || '';
        return String(el.value ?? '').toLowerCase() === want || String(sel ?? '').toLowerCase().includes(want);
      }
      if (type === 'checkbox') {
        const should = value === true || value === 'true' || value === 'yes';
        return el.checked === should;
      }
      if (type === 'radio') {
        const group = el.name ? document.querySelectorAll(`input[type="radio"][name="${el.name}"]`) : [el];
        for (const r of group) {
          if (r.checked) {
            let lab = '';
            if (r.id) lab = document.querySelector(`label[for="${r.id}"]`)?.innerText || '';
            if (!lab) lab = r.closest('label')?.innerText || '';
            return String(r.value ?? '').toLowerCase() === want || String(lab ?? '').toLowerCase().includes(want);
          }
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
  }

  const executor = new BrowserExecutor();

  // 6. Runtime Message Listener
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, payload } = message;

    switch (type) {
      case MessageType.EXTRACT_DOM:
        stabilityObserver.waitForStability(200, 1000).then(() => {
          const domData = domExtractor.extractPageElements();
          sendResponse({ success: true, data: domData });
        }).catch(err => {
          sendResponse({ success: false, error: err.message });
        });
        return true; // Keep message channel open for async response

      case MessageType.EXECUTE_ACTION:
        executor.execute(payload).then(result => {
          sendResponse(result);
        }).catch(err => {
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
        });
        return true;

      default:
        break;
    }
  });
})();
