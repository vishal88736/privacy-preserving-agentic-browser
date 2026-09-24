import { registry } from './element-registry.js';

export class FormFiller {
  async executePlan(plan) {
    const results = [];
    const fields = plan?.fields || [];
    
    for (const field of fields) {
      if (field.status === 'UNAVAILABLE' || field.status === 'AMBIGUOUS') {
        results.push({ field: field.field_id, success: false, status: field.status });
        continue;
      }
      if (field.value === undefined || field.value === null || field.value === '') {
        results.push({ field: field.field_id, success: false, status: 'UNAVAILABLE' });
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

  /**
   * Normalizes vault date formats for native date inputs, which only accept
   * YYYY-MM-DD. Vault DOBs are stored DD/MM/YYYY; assigning that string to
   * <input type=date> is silently rejected by the browser (value stays ''),
   * so verification would always fail without this conversion.
   */
  _normalizeDateForInput(el, value) {
    try {
      const type = String(el?.type || '').toLowerCase();
      if (type !== 'date' || typeof value !== 'string') return value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
      const m = String(value).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
      if (m) {
        const dd = m[1].padStart(2, '0');
        const mm = m[2].padStart(2, '0');
        return `${m[3]}-${mm}-${dd}`;
      }
    } catch { /* fall through with original value */ }
    return value;
  }

  async _fillElement(el, fieldData) {
    const value = this._normalizeDateForInput(el, fieldData.value);
    // Keep verification consistent with what was actually assigned.
    fieldData.value = value;

    const actualControlType = this._controlType(el);
    if (fieldData.control_type && fieldData.control_type !== actualControlType) {
      throw new Error('The form control changed after observation. Re-observe before acting.');
    }

    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await this.sleep(100);
    el.focus();

    if (el.tagName === 'SELECT') {
      await this._fillSelect(el, value, fieldData.options, fieldData.semantic_type);
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
    const win = typeof window !== 'undefined' ? window : {};
    const proto = String(el?.tagName || '').toUpperCase() === 'TEXTAREA'
      ? win.HTMLTextAreaElement?.prototype
      : win.HTMLInputElement?.prototype;
    const nativeInputValueSetter = proto
      ? Object.getOwnPropertyDescriptor(proto, 'value')?.set
      : null;
    
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async _fillSelect(el, value, options = [], semanticType = '') {
    const matchedOption = this._findSelectOption(el, value, semanticType);
    if (!matchedOption) throw new Error('No select option matches the configured profile value.');
    const expectedIndex = Array.from(el.options).indexOf(matchedOption);
    if (el.selectedIndex !== expectedIndex) {
      const setter = typeof window !== 'undefined'
        ? Object.getOwnPropertyDescriptor(window.HTMLSelectElement?.prototype || {}, 'value')?.set
        : null;
      if (setter) setter.call(el, matchedOption.value);
      else el.value = matchedOption.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  _normalizeOptionValue(value, semanticType = '') {
    let normalized = String(value ?? '').trim().toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ');
    if (semanticType === 'country') {
      const countryAliases = new Map([
        ['us', 'united states'], ['u s', 'united states'], ['usa', 'united states'],
        ['u s a', 'united states'], ['united states of america', 'united states'],
        ['in', 'india'], ['uk', 'united kingdom'], ['u k', 'united kingdom'],
        ['great britain', 'united kingdom']
      ]);
      normalized = countryAliases.get(normalized) || normalized;
    }
    return normalized;
  }

  _findSelectOption(el, value, semanticType = '') {
    const target = this._normalizeOptionValue(value, '');
    const normalize = (v) => this._normalizeOptionValue(v, semanticType);
    const available = Array.from(el.options || []);
    return available.find((option) => String(option.value ?? '').trim() === String(value ?? '').trim())
      || available.find((option) => normalize(option.value) === normalize(value))
      || available.find((option) => normalize(option.text) === normalize(value))
      || available.find((option) => normalize(option.text).includes(normalize(value)) && target.length >= 3);
  }

  async _fillCheckbox(el, value) {
    const shouldBeChecked = this._checkboxTarget(value);
    if (el.checked !== shouldBeChecked) {
      el.click();
    }
  }

  _checkboxTarget(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    const normalized = String(value ?? '').trim().toLowerCase();
    if (['yes', 'true', '1', 'checked', 'agree', 'agreed', 'accepted', 'accept'].includes(normalized)) return true;
    if (['no', 'false', '0', 'unchecked', 'decline', 'declined', 'not agree', ''].includes(normalized)) return false;
    throw new Error('The configured checkbox value is ambiguous.');
  }

  async _fillRadio(el, value, options = []) {
    // Locate the specific radio button in the group that matches the value
    // el might just be one of the radios
    const groupName = el.name;
    const want = this._normalizeOptionValue(value);
    const group = groupName
      ? Array.from(document.querySelectorAll('input[type="radio"]')).filter((radio) => radio.name === groupName)
      : [el];
    for (const radio of group) {
      const labelText = this._getLabelText(radio);
      if (this._normalizeOptionValue(radio.value) === want || this._normalizeOptionValue(labelText) === want) {
        if (!radio.checked) {
          radio.click();
        }
        return;
      }
    }
    throw new Error('No radio option matches the configured profile value.');
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
    const value = this._normalizeDateForInput(el, fieldData.value);
    if (el.tagName === 'SELECT') {
      const expectedOption = this._findSelectOption(el, value, fieldData.semantic_type);
      return Boolean(expectedOption) && el.selectedIndex === Array.from(el.options).indexOf(expectedOption) &&
        el.options[el.selectedIndex]?.selected === true;
    } else if (el.type === 'checkbox') {
      const shouldBeChecked = this._checkboxTarget(value);
      return el.checked === shouldBeChecked;
    } else if (el.type === 'radio') {
      const groupName = el.name;
      if (!groupName) return String(el.value ?? '').toLowerCase() === String(value ?? '').toLowerCase() && el.checked === true;
      const group = groupName
        ? Array.from(document.querySelectorAll('input[type="radio"]')).filter((radio) => radio.name === groupName)
        : [el];
      for (const radio of group) {
        const labelText = this._getLabelText(radio);
        const expected = this._normalizeOptionValue(value);
        const matches = this._normalizeOptionValue(radio.value) === expected || this._normalizeOptionValue(labelText) === expected;
        if (matches) {
          return radio.checked === true;
        }
      }
      return false;
    } else {
      return String(el.value ?? '').toLowerCase() === String(value ?? '').toLowerCase();
    }
  }

  _controlType(el) {
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
}
export const formFiller = new FormFiller();
