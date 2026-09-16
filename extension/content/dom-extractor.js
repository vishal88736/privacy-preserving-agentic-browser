/**
 * DOM Extractor
 * Traverses active webpage DOM to gather interactive elements, forms,
 * labels, bounding boxes, and accessibility descriptors.
 */

import { registry } from './element-registry.js';

export class DOMExtractor {
  /**
   * Computes the accessible label for an input element
   */
  getAccessibleLabel(element) {
    // 1. aria-labelledby
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.innerText.trim();
    }

    // 2. aria-label
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    // 3. HTML <label for="id">
    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) return label.innerText.trim();
    }

    // 4. Closest wrapping <label>
    const parentLabel = element.closest('label');
    if (parentLabel) {
      return parentLabel.innerText.trim();
    }

    // 5. Placeholder
    if (element.placeholder) return element.placeholder.trim();

    // 6. Name or title attribute
    if (element.title) return element.title.trim();
    if (element.name) return element.name.trim();

    // 7. InnerText for buttons / links
    if (element.innerText && element.innerText.trim()) {
      return element.innerText.trim().slice(0, 80);
    }

    return '';
  }

  /**
   * Checks if an element is visible in the viewport
   */
  isElementVisible(element, rect) {
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    // Check if within reasonable screen boundaries
    return rect.top < window.innerHeight && rect.bottom > 0 &&
           rect.left < window.innerWidth && rect.right > 0;
  }

  /**
   * Extracts visible interactive elements from the page
   */
  extractPageElements() {
    registry.clear();
    const selector = 'input, button, a, select, textarea, [role="button"], [role="textbox"], [role="checkbox"], [tabindex]:not([tabindex="-1"])';
    const rawNodes = Array.from(document.querySelectorAll(selector));

    const extracted = [];

    for (const node of rawNodes) {
      const rect = node.getBoundingClientRect();
      const isVisible = this.isElementVisible(node, rect);

      // Skip elements that are completely hidden
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
          // node.form works for input/button/select/textarea.
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

export const defaultDOMExtractor = new DOMExtractor();
