import { registry } from './element-registry.js';

// Escape ids for attribute selectors (colons/dots/brackets in ids would
// break the selector). CSS.escape is unavailable in Node test environments,
// so fall back to a conservative escape.
function escapeIdForSelector(id) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(id));
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

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
   * YYYY-MM-DD. The day/month order is DETECTED from impossible-month
   * values (a part > 12 must be the day); ambiguous values default to the
   * vault's documented DD/MM/YYYY convention. Assigning a wrong-order string
   * to <input type=date> is silently rejected by the browser (value stays
   * ''), so verification would always fail without this conversion.
   */
  _normalizeDateForInput(el, value) {
    try {
      const type = String(el?.type || '').toLowerCase();
      if (type !== 'date' || typeof value !== 'string') return value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
      const m = String(value).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
      if (m) {
        const first = Number(m[1]);
        const second = Number(m[2]);
        const monthFirst = first <= 12 && second > 12;
        return monthFirst
          ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
          : `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
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
      await this._waitForFieldSettle(el);
    } else if (el.type === 'checkbox') {
      await this._fillCheckbox(el, value);
    } else if (el.type === 'radio') {
      await this._fillRadio(el, value, fieldData.options);
      await this._waitForFieldSettle(el);
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
    // Substring matching is a last resort and strictly bounded: short
    // substrings match unrelated options ("New" must not match
    // "New Hampshire"), so require a minimum length AND that the target
    // covers most of the option text.
    const substringOk = (option) => {
      const text = normalize(option.text);
      return target.length >= 5 && text.includes(target) && target.length >= text.length * 0.6;
    };
    return available.find((option) => String(option.value ?? '').trim() === String(value ?? '').trim())
      || available.find((option) => normalize(option.value) === normalize(value))
      || available.find((option) => normalize(option.text) === normalize(value))
      || available.find(substringOk);
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
    // el might just be one of the radios. The group is scoped to radios in
    // the SAME form: identically-named groups in different forms are
    // independent questions.
    const groupName = el.name;
    const want = this._normalizeOptionValue(value);
    const group = groupName
      ? Array.from(document.querySelectorAll('input[type="radio"]')).filter((radio) => radio.name === groupName && radio.form === el.form)
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
      const label = document.querySelector(`label[for="${escapeIdForSelector(el.id)}"]`);
      if (label) return label.innerText;
    }
    const parentLabel = el.closest('label');
    if (parentLabel) return parentLabel.innerText;
    return '';
  }

  /**
   * Frameworks react to SELECT/RADIO state changes asynchronously (dependent
   * dropdowns, revealed sections). Wait for the DOM to settle — 150ms of
   * quiet, hard-capped at 500ms — before filling the next field. Falls back
   * to a fixed pause when MutationObserver is unavailable (Node tests).
   */
  async _waitForFieldSettle(el) {
    const scope = el?.form || el?.parentNode || (typeof document !== 'undefined' ? document.body : null);
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
        ? Array.from(document.querySelectorAll('input[type="radio"]')).filter((radio) => radio.name === groupName && radio.form === el.form)
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
