import { registry } from './element-registry.js';

export class FormFiller {
  async executePlan(plan) {
    const results = [];
    
    for (const field of plan.fields) {
      if (!field.value) {
        // value should be resolved before this gets called. If not, skip
        console.warn('FormFiller: Skipping field, no value provided', field);
        continue;
      }
      
      const el = registry.getElement(field.field_id);
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
    // Attempt to find matching option by value or text
    let matchedOption = Array.from(el.options).find(o => 
      o.value.toLowerCase() === value.toLowerCase() || 
      o.text.toLowerCase().includes(value.toLowerCase())
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

    const group = document.querySelectorAll(`input[type="radio"][name="${groupName}"]`);
    for (const radio of group) {
      const labelText = this._getLabelText(radio);
      if (radio.value.toLowerCase() === value.toLowerCase() || labelText.toLowerCase().includes(value.toLowerCase())) {
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
      return el.value.toLowerCase() === String(value).toLowerCase() || selectedText.toLowerCase().includes(String(value).toLowerCase());
    } else if (el.type === 'checkbox') {
      const shouldBeChecked = value === true || value === 'true' || value === 'yes';
      return el.checked === shouldBeChecked;
    } else if (el.type === 'radio') {
      const groupName = el.name;
      if (!groupName) return false;
      const group = document.querySelectorAll(`input[type="radio"][name="${groupName}"]`);
      for (const radio of group) {
        if (radio.checked) {
          const labelText = this._getLabelText(radio);
          return radio.value.toLowerCase() === String(value).toLowerCase() || labelText.toLowerCase().includes(String(value).toLowerCase());
        }
      }
      return false;
    } else {
      return el.value.toLowerCase() === String(value).toLowerCase();
    }
  }
}
export const formFiller = new FormFiller();
