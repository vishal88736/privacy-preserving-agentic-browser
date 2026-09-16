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

  // 2. DOM Extractor
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

    extractPageElements() {
      registry.clear();
      const selector = 'input, button, a, select, textarea, [role="button"], [role="textbox"], [role="checkbox"], [tabindex]:not([tabindex="-1"])';
      const rawNodes = Array.from(document.querySelectorAll(selector));

      const extracted = [];

      for (const node of rawNodes) {
        const rect = node.getBoundingClientRect();
        const isVisible = this.isElementVisible(node, rect);

        if (!isVisible && node.type !== 'file') continue;

        const id = registry.register(node);
        const tag = node.tagName.toLowerCase();
        const label = this.getAccessibleLabel(node);

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
           // True when the control belongs to a <form> (matters because an
           // unlabeled typeless <button> only submits when form-associated).
           in_form: Boolean(node.form),
          checked: Boolean(node.checked),
          bbox: [
            Math.round(rect.left),
            Math.round(rect.top),
            Math.round(rect.width),
            Math.round(rect.height)
          ],
          is_interactive: true,
          is_visible: isVisible
        });
      }

      return {
        url: window.location.href,
        title: document.title || 'Untitled Document',
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
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
          if (targetElement) targetElement.checked = true;
          return { success: true };

        case 'UNCHECK':
          if (targetElement) targetElement.checked = false;
          return { success: true };

        case 'SCROLL':
          window.scrollBy({ left: actionPayload.deltaX || 0, top: actionPayload.deltaY || 300, behavior: 'smooth' });
          await this.sleep(250);
          return { success: true };

        case 'UPLOAD':
          return this._executeUpload(targetElement, resolvedValue);

        case 'SUBMIT':
          return this._executeSubmit(targetElement);

        case 'WAIT':
          await this.sleep(actionPayload.duration || 1000);
          return { success: true };

        default:
          return { success: true };
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
      const valueToSet = String(text || '');

      element.focus();
      element.value = '';
      element.dispatchEvent(new Event('input', { bubbles: true }));

      element.value = valueToSet;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: valueToSet }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));

      return { success: true };
    }

    async _executeSelect(element, optionValue) {
      if (!element) throw new Error('Target select element not found');
      element.focus();
      element.value = optionValue;
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
