/**
 * Browser DOM Action Executor
 * Runs inside the webpage context to execute clicks, simulated typing,
 * select changes, and document uploads.
 */

import { registry } from './element-registry.js';
import { visualOverlay } from './visual-overlay.js';

export class BrowserExecutor {
  /**
   * Executes an action on a target element or coordinates
   */
  async execute(actionPayload) {
    const { action, target, resolvedValue, coordinates } = actionPayload;

    let targetElement = null;
    if (target?.element_id) {
      targetElement = registry.getElement(target.element_id);
    }

    // If target has coordinates, or element_id was not matched, use elementFromPoint
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
        return this._executeCheck(targetElement, true);

      case 'UNCHECK':
        return this._executeCheck(targetElement, false);

      case 'SCROLL':
        return this._executeScroll(actionPayload.deltaX || 0, actionPayload.deltaY || 300);

      case 'UPLOAD':
        return this._executeUpload(targetElement, resolvedValue);

      case 'SUBMIT':
        return this._executeSubmit(targetElement);

      case 'WAIT':
        await this.sleep(actionPayload.duration || 1000);
        return { success: true };

      case 'PRESS_KEY': {
        const key = resolvedValue || actionPayload.value || 'Enter';
        const target = targetElement || document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: String(key) }));
        target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: String(key) }));
        return { success: true };
      }
      case 'HOVER':
        if (targetElement) {
          targetElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
          return { success: true };
        }
        throw new Error('Hover target element not found');
      case 'GO_BACK':
        window.history.back();
        await this.sleep(600);
        return { success: true };
      case 'GO_FORWARD':
        window.history.forward();
        await this.sleep(600);
        return { success: true };

      default:
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
      const [x, y] = coords;
      const el = document.elementFromPoint(x, y);
      if (el) {
        el.click();
        return { success: true };
      }
    }

    throw new Error('Click target element not found');
  }

  async _executeType(element, text) {
    if (!element) throw new Error('Type target element not found');
    const valueToSet = String(text || '');

    element.focus();
    // Clear existing text
    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));

    // Set new value
    element.value = valueToSet;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: valueToSet }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));

    return { success: true };
  }

  async _executeSelect(element, optionValue) {
    if (!element) throw new Error('Select target element not found');
    element.focus();
    element.value = optionValue;
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  }

  async _executeCheck(element, shouldCheck) {
    if (!element) throw new Error('Checkbox target element not found');
    if (element.checked !== shouldCheck) {
      element.click();
    }
    return { success: true };
  }

  async _executeScroll(deltaX, deltaY) {
    window.scrollBy({ left: deltaX, top: deltaY, behavior: 'smooth' });
    await this.sleep(250);
    return { success: true };
  }

  async _executeUpload(element, docData) {
    if (!element) throw new Error('Upload target element not found');

    const fileName = docData?.name || 'document.pdf';
    const mimeType = docData?.type || 'application/pdf';
    const fileContent = docData?.content || 'Dummy PDF content';

    // Create synthetic file attachment
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
      if (element.form) {
        element.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        element.click();
      } else {
        element.click();
      }
      return { success: true };
    }
    throw new Error('Submit button element not found');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export const browserExecutor = new BrowserExecutor();
