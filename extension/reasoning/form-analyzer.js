/**
 * Form Analyzer
 * Takes form evidence extracted by DOM extractor and classifies each field semantically,
 * then maps it to local value sources.
 */

import { SymbolicSecretSource } from '../shared/constants.js';
import { defaultLocalVault } from '../privacy/local-vault.js';

const SEMANTIC_PATTERNS = [
  { type: 'first_name', regex: /\b(first.?name|fname|given.?name)\b/i, weight: 1.0 },
  { type: 'last_name', regex: /\b(last.?name|lname|surname|family.?name)\b/i, weight: 1.0 },
  { type: 'full_name', regex: /\b(full.?name|your.?name|applicant|candidate.?name|\bname\b)\b/i, weight: 0.8 },
  { type: 'email', regex: /\b(email|e-mail|mail\s*address)\b/i, weight: 1.0 },
  { type: 'phone', regex: /\b(phone|mobile|tel|contact\s*number|cell)\b/i, weight: 1.0 },
  { type: 'date_of_birth', regex: /\b(dob|date.?of.?birth|birth.?date)\b/i, weight: 1.0 },
  { type: 'password', regex: /\b(password|passcode|secret|pin)\b/i, weight: 1.0 },
  { type: 'address_line1', regex: /\b(address.?1|street.?address|address.?line.?1|address)\b/i, weight: 0.9 },
  { type: 'city', regex: /\b(city|town)\b/i, weight: 1.0 },
  { type: 'state', regex: /\b(state|province|region)\b/i, weight: 1.0 },
  { type: 'zip_code', regex: /\b(zip|postal.?code|pincode|postcode)\b/i, weight: 1.0 },
  { type: 'country', regex: /\b(country|nation)\b/i, weight: 1.0 },
  { type: 'gender', regex: /\b(gender|sex)\b/i, weight: 1.0 },
  { type: 'newsletter', regex: /\b(newsletter|subscribe|opt.?in|updates|promotions)\b/i, weight: 0.9 },
  { type: 'comments', regex: /\b(comments?|remarks|notes|additional.?info|message)\b/i, weight: 0.9 },
  { type: 'other', regex: /\b(other|custom\s+preference)\b/i, weight: 0.8 },
  { type: 'pan', regex: /\b(pan|pan.?number|pan.?card|permanent.?account.?number)\b/i, weight: 1.0 },
  { type: 'ssn', regex: /\b(ssn|social.?security(?:.?number)?)\b/i, weight: 1.0 },
  { type: 'sin', regex: /\b(sin|social.?insurance(?:.?number)?)\b/i, weight: 1.0 },
  { type: 'nin', regex: /\b(nin|national.?insurance(?:.?number)?)\b/i, weight: 1.0 },
  { type: 'nhs', regex: /\bnhs(?:.?number)?\b/i, weight: 1.0 },
  { type: 'iban', regex: /\biban\b/i, weight: 1.0 },
  { type: 'aadhaar', regex: /\b(aadhaar|aadhar|uidai)\b/i, weight: 1.0 },
  { type: 'passport', regex: /\bpassport(?:.?number|.?no\.?)?\b/i, weight: 1.0 },
  { type: 'driver_license', regex: /\b(?:driver.?s?.?licen[cs]e|driving.?licen[cs]e)\b/i, weight: 1.0 },
  { type: 'national_id', regex: /\b(?:national.?id|identity.?number|id.?number)\b/i, weight: 0.95 },
  { type: 'tax_id', regex: /\b(?:tax.?id|tax.?identification.?number)\b/i, weight: 0.95 },
  { type: 'terms', regex: /\b(terms|conditions|agree|accept)\b/i, weight: 1.0 }
];

export class FormAnalyzer {
  constructor(vault = defaultLocalVault) {
    this.vault = vault;
  }

  /**
   * Normalize flat extractor elements AND fused {id, dom, interaction}
   * elements into a common flat shape so bulk planning works on real
   * observations. Fused elements nest tag/type/label/etc. under .dom.
   */
  _norm(el) {
    if (!el || typeof el !== 'object') return {};
    const dom = el.dom && typeof el.dom === 'object' ? el.dom : {};
    const get = (key, fb = '') => {
      const top = el[key];
      if (top !== undefined && top !== null && top !== '') return top;
      const nested = dom[key];
      if (nested !== undefined && nested !== null && nested !== '') return nested;
      return fb;
    };
    return {
      id: el.element_id || el.id || dom.id || '',
      tag: get('tag'),
      type: get('type'),
      name: get('name'),
      label: get('label'),
      placeholder: get('placeholder'),
      ariaLabel: el.ariaLabel || dom.ariaLabel || dom.aria_label || '',
      ariaDescribedBy: el.ariaDescribedBy || dom.ariaDescribedBy || '',
      fieldset_legend: el.fieldset_legend || dom.fieldset_legend || dom.legend || '',
      context: get('context'),
      disabled: Boolean(el.disabled || dom.disabled),
      in_form: Boolean(el.in_form || dom.in_form || el.form || dom.inForm),
      form_id: el.form_id || dom.form_id || el.formId || dom.formId || null,
      options: el.options || dom.options,
      semantic_type: el.semantic_type || dom.semantic_type || '',
      autocomplete: el.autocomplete || dom.autocomplete || '',
      value: el.value !== undefined ? el.value : dom.value,
      checked: el.checked !== undefined ? el.checked : dom.checked,
      _raw: el
    };
  }
  
  analyzeForms(elements, userGoal) {
    const forms = new Map();
    const floatingFields = [];

    // Group fields by form (works for flat + fused shapes)
    elements.forEach(raw => {
      const el = this._norm(raw);
      if (!el.in_form && !el.form_id) {
        floatingFields.push(el);
      } else {
        const key = el.form_id || 'implicit_form';
        if (!forms.has(key)) forms.set(key, []);
        forms.get(key).push(el);
      }
    });

    if (floatingFields.length > 0) {
      forms.set('floating', floatingFields);
    }

    const plans = [];

    forms.forEach((fields, formId) => {
      const plan = {
        form_id: formId,
        fields: [],
        // Fields the agent classified but cannot fill from the vault
        // (no value mapping). The planner surfaces these via ASK_USER
        // instead of silently dropping them.
        ambiguous: []
      };

      const radioGroups = new Set();

      fields.forEach(field => {
        if (!this.isFillable(field)) return;

        const classification = this.classifyField(field);
        if (classification) {
          const controlType = this.controlType(field);
          const radioKey = controlType === 'RADIO' ? `${formId}:${field.name || field.id}` : null;
          // A radio group is one semantic field. Its options carry the full
          // group state, so planning each radio independently can duplicate
          // contradictory work.
          if (radioKey && radioGroups.has(radioKey)) return;
          if (radioKey) radioGroups.add(radioKey);
          const valueSource = this.mapToValueSource(classification.semantic_type);

          if (valueSource) {
            const entry = {
              field_id: field.id,
              semantic_type: classification.semantic_type,
              label: String(field.label || field.placeholder || field.name || classification.semantic_type).slice(0, 80),
              control_type: controlType,
              value_source: valueSource,
              confidence: classification.confidence,
              element_type: field.tag,
              input_type: field.type,
              current_state: this.currentState(field, controlType),
              target_state: valueSource,
              options: field.options
            };
            const part = this.addressPartFor(classification.semantic_type);
            if (part) entry.address_part = part;
            plan.fields.push(entry);
          } else {
            plan.ambiguous.push({
              field_id: field.id,
              semantic_type: classification.semantic_type,
              control_type: controlType,
              confidence: classification.confidence,
              element_type: field.tag,
              input_type: field.type,
              current_state: this.currentState(field, controlType),
              options: field.options,
              label: String(field.label || field.placeholder || field.name || '').slice(0, 80),
              reason: `No saved value for "${classification.semantic_type}" — needs user clarification.`
            });
          }
        }
      });

      if (plan.fields.length > 0 || plan.ambiguous.length > 0) {
        plans.push(plan);
      }
    });

    return plans;
  }

  isFillable(field) {
    const f = this._norm(field);
    if (f.disabled) return false;
    const tag = String(f.tag || '').toLowerCase();
    const type = String(f.type || '').toLowerCase();
    if (tag === 'button' || tag === 'a') return false;
    if (['submit', 'hidden', 'file', 'button', 'image', 'reset'].includes(type)) return false;
    return true;
  }

  classifyField(field) {
    const f = this._norm(field);
    const normalizeEvidence = (parts) => parts.filter(Boolean).join(' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ');
    const autocomplete = String(f.autocomplete || '').toLowerCase().trim();
    if (autocomplete === 'name') return { semantic_type: 'full_name', confidence: 0.99 };
    if (autocomplete === 'given-name') return { semantic_type: 'first_name', confidence: 0.99 };
    if (autocomplete === 'family-name') return { semantic_type: 'last_name', confidence: 0.99 };
    if (autocomplete === 'email' || String(f.type).toLowerCase() === 'email') {
      return { semantic_type: 'email', confidence: 0.99 };
    }
    if (['tel', 'tel-national', 'tel-country-code'].includes(autocomplete) || String(f.type).toLowerCase() === 'tel') {
      return { semantic_type: 'phone', confidence: 0.99 };
    }

    // Prefer the field's own identifying attributes to nearby context. A
    // generic "Name" control should not become first_name just because the
    // surrounding form also has a separate first-name field.
    const directEvidence = normalizeEvidence([f.label, f.name, f.id, f.placeholder, f.ariaLabel, f.semantic_type]);
    const specificName = directEvidence.match(/\b(first.?name|fname|given.?name)\b/i);
    if (specificName) return { semantic_type: 'first_name', confidence: 0.99 };
    const familyName = directEvidence.match(/\b(last.?name|lname|surname|family.?name)\b/i);
    if (familyName) return { semantic_type: 'last_name', confidence: 0.99 };
    if (/\b(full.?name|your.?name|applicant.?name|candidate.?name|name)\b/i.test(directEvidence)) {
      return { semantic_type: 'full_name', confidence: 0.95 };
    }
    const evidence = normalizeEvidence([
      f.label,
      f.name,
      f.id,
      f.placeholder,
      f.ariaLabel,
      f.ariaDescribedBy,
      f.fieldset_legend,
      f.context,
      f.semantic_type
    ]);

    let bestMatch = null;
    let highestScore = 0;

    SEMANTIC_PATTERNS.forEach(pattern => {
      const match = evidence.match(pattern.regex);
      if (match) {
        // Boost score if matched in more critical attributes (like name or label vs just nearby text)
        let score = pattern.weight;
        if (f.name && f.name.match(pattern.regex)) score += 0.5;
        if (f.label && f.label.match(pattern.regex)) score += 0.5;
        if (f.id && f.id.match(pattern.regex)) score += 0.4;
        
        if (score > highestScore) {
          highestScore = score;
          bestMatch = pattern.type;
        }
      }
    });

    if (bestMatch) {
      return {
        semantic_type: bestMatch,
        confidence: Math.min(highestScore / 2.0, 0.99)
      };
    }

    return null;
  }

  mapToValueSource(semanticType) {
    const map = {
      'first_name': SymbolicSecretSource.LOCAL_FULL_NAME, // A better resolver would split this
      'last_name': SymbolicSecretSource.LOCAL_FULL_NAME,
      'full_name': SymbolicSecretSource.LOCAL_FULL_NAME,
      'email': SymbolicSecretSource.LOCAL_EMAIL,
      'phone': SymbolicSecretSource.LOCAL_PHONE,
      'date_of_birth': SymbolicSecretSource.LOCAL_DOB,
      'dob': SymbolicSecretSource.LOCAL_DOB,
      'password': SymbolicSecretSource.LOCAL_PASSWORD,
      'address_line1': SymbolicSecretSource.LOCAL_ADDRESS,
      // Address sub-fields resolve from LOCAL_ADDRESS via the structured
      // address resolver (LocalValueResolver + address_part). They must NOT
      // fall back to LOCAL_PROFILE (a name string) — see analyzeForms.
      'city': SymbolicSecretSource.LOCAL_ADDRESS,
      'state': SymbolicSecretSource.LOCAL_ADDRESS,
      'zip_code': SymbolicSecretSource.LOCAL_ADDRESS,
      'pan': SymbolicSecretSource.LOCAL_PAN,
      'ssn': SymbolicSecretSource.LOCAL_SSN,
      'sin': SymbolicSecretSource.LOCAL_SIN,
      'nin': SymbolicSecretSource.LOCAL_NIN,
      'nhs': SymbolicSecretSource.LOCAL_NHS,
      'iban': SymbolicSecretSource.LOCAL_IBAN,
      'aadhaar': SymbolicSecretSource.LOCAL_AADHAAR,
      'country': SymbolicSecretSource.LOCAL_COUNTRY,
      'gender': SymbolicSecretSource.LOCAL_GENDER,
      'terms': SymbolicSecretSource.LOCAL_TERMS,
      // Opt-in and free-text fields have no vault mapping: the planner must
      // ask the user (ASK_USER) instead of guessing. null = needs user.
      'newsletter': null,
      'comments': null,
      'other': null
    };
    // NOTE: null is a meaningful "needs user" signal (newsletter/comments),
    // so test key presence — ?? and || would both swallow it into
    // LOCAL_PROFILE.
    const key = semanticType?.toLowerCase();
    if (key && Object.hasOwn(map, key)) return map[key];
    const customKey = `LOCAL_CUSTOM_${String(key || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48)}`;
    if (key && this.vault.resolveSecret(customKey)) return customKey;
    if (['passport', 'driver_license', 'national_id', 'tax_id'].includes(key)) return null;
    return SymbolicSecretSource.LOCAL_PROFILE;
  }

  /**
   * Address sub-field routing: city/state/zip resolve from the street
   * address record held under LOCAL_ADDRESS. Returns the address_part the
   * LocalValueResolver must extract, or null for non-address semantics.
   */
  addressPartFor(semanticType) {
    const part = {
      'city': 'city',
      'state': 'state',
      'zip_code': 'zip'
    }[semanticType?.toLowerCase()];
    return part || null;
  }

  controlType(field) {
    const f = this._norm(field);
    const tag = String(f.tag || '').toLowerCase();
    const type = String(f.type || '').toLowerCase();
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

  currentState(field, controlType = this.controlType(field)) {
    const f = this._norm(field);
    if (controlType === 'CHECKBOX') return f.checked ? 'CHECKED' : 'UNCHECKED';
    if (controlType === 'RADIO') {
      return (f.checked || (f.options || []).some((option) => option?.checked)) ? 'SELECTED' : 'UNSELECTED';
    }
    if (controlType === 'SELECT') return f.value ? 'SELECTED' : 'UNSELECTED';
    const value = String(f.value ?? '').trim();
    return value && value !== '[REDACTED]' && value !== '[NON_SENSITIVE_TEXT]' ? 'FILLED' : 'EMPTY';
  }
}

export const defaultFormAnalyzer = new FormAnalyzer();
