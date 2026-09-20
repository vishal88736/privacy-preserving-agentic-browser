import { registry } from './element-registry.js';

export class FormFiller {
  async executePlan(plan) {
    const results = [];
    const fields = plan?.fields || [];
    
    for (const field of fields) {
      if (field.value === undefined || field.value === null || field.value === '') {
        results.push({ field: field.field_id, success: false, reason: `Missing value for "${field.field_id}" (${field.value_source || 'no source'}). Add it to the Local Vault.` });
        continue;
      }
      
      let el = registry.getElement(field.field_id);
      if (!el) {
        el = document.getElementById(field.field_id);
        if (!el) {
          try {
            el = document.querySelector(`[name="${field.field_id}"]`);
          } catch (e) {
            // Ignore SyntaxError from invalid selectors (like xpaths)
          }
        }
      }
      
      if (!el) {
        results.push({ field: field.field_id, success: false, reason: 'Element not found' });
        continue;
      }

      try {
        await this._fillElement(el, field);
        const verified = await this._verifyElement(el, field);
        if (verified) {
          results.push({ field: field.field_id, success: true });
        } else {
          results.push({ field: field.field_id, success: false, reason: 'Verification failed: value mismatch' });
        }
      } catch (e) {
        results.push({ field: field.field_id, success: false, reason: e.message });
      }
    }
    
    return { success: results.every(r => r.success), details: results };
  }

  async _fillElement(el, fieldData) {
    const value = fieldData.value;

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await this.sleep(100);
    el.focus();

    if (el.tagName === 'SELECT') {
      await this._fillSelect(el, value, fieldData.options);
    } else if (el.type === 'checkbox') {
      await this._fillCheckbox(el, value);
    } else if (el.type === 'radio') {
      await this._fillRadio(el, value, fieldData.options);
    } else {
      await this._fillText(el, value);
    }

    el.dispatchEvent(new Event('blur', { bubbles: true }));
    await this.sleep(50);
  }

  async _fillText(el, value) {
    // Framework-compatible native value setter
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                                || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async _fillSelect(el, value, options = []) {
    // Attempt to find matching option by value or text (String-safe)
    const want = String(value ?? '').toLowerCase();
    let matchedOption = Array.from(el.options).find(o =>
      String(o.value ?? '').toLowerCase() === want ||
      String(o.text ?? '').toLowerCase().includes(want)
    );

    if (matchedOption) {
      el.value = matchedOption.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  async _fillCheckbox(el, value) {
    const shouldBeChecked = value === true || value === 'true' || value === 'yes';
    if (el.checked !== shouldBeChecked) {
      el.click();
    }
  }

  async _fillRadio(el, value, options = []) {
    // Locate the specific radio button in the group that matches the value
    // el might just be one of the radios
    const groupName = el.name;
    if (!groupName) return;
    const want = String(value ?? '').toLowerCase();

    const group = document.querySelectorAll(`input[type="radio"][name="${groupName}"]`);
    for (const radio of group) {
      const labelText = this._getLabelText(radio);
      if (String(radio.value ?? '').toLowerCase() === want || String(labelText ?? '').toLowerCase().includes(want)) {
        if (!radio.checked) {
          radio.click();
        }
        return;
      }
    }
  }

  _getLabelText(el) {
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return label.innerText;
    }
    const parentLabel = el.closest('label');
    if (parentLabel) return parentLabel.innerText;
    return '';
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async _verifyElement(el, fieldData) {
    const value = fieldData.value;
    if (el.tagName === 'SELECT') {
      const selectedText = el.options[el.selectedIndex]?.text || '';
      return String(el.value ?? '').toLowerCase() === String(value ?? '').toLowerCase() || String(selectedText ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
    } else if (el.type === 'checkbox') {
      const shouldBeChecked = value === true || value === 'true' || value === 'yes';
      return el.checked === shouldBeChecked;
    } else if (el.type === 'radio') {
      const groupName = el.name;
      if (!groupName) return String(el.value ?? '').toLowerCase() === String(value ?? '').toLowerCase() && el.checked === true;
      const group = document.querySelectorAll(`input[type="radio"][name="${groupName}"]`);
      for (const radio of group) {
        const labelText = this._getLabelText(radio);
        const matches = String(radio.value ?? '').toLowerCase() === String(value ?? '').toLowerCase() || String(labelText ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
        if (matches) {
          return radio.checked === true;
        }
      }
      return false;
    } else {
      return String(el.value ?? '').toLowerCase() === String(value ?? '').toLowerCase();
    }
  }
}
export const formFiller = new FormFiller();
