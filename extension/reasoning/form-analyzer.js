/**
 * Form Analyzer
 * Takes form evidence extracted by DOM extractor and classifies each field semantically,
 * then maps it to local value sources.
 */

import { SymbolicSecretSource } from '../shared/constants.js';

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
  { type: 'pan', regex: /\b(pan.?number|pan.?card|permanent.?account.?number)\b/i, weight: 1.0 },
  { type: 'aadhaar', regex: /\b(aadhaar|aadhar|uidai)\b/i, weight: 1.0 }
];

export class FormAnalyzer {
  
  analyzeForms(elements, userGoal) {
    const forms = new Map();
    const floatingFields = [];

    // Group fields by form
    elements.forEach(el => {
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
        fields: []
      };

      fields.forEach(field => {
        if (!this.isFillable(field)) return;

        const classification = this.classifyField(field);
        if (classification) {
          const valueSource = this.mapToValueSource(classification.semantic_type);
          
          plan.fields.push({
            field_id: field.id,
            semantic_type: classification.semantic_type,
            value_source: valueSource,
            confidence: classification.confidence,
            element_type: field.tag,
            input_type: field.type,
            options: field.options
          });
        }
      });

      if (plan.fields.length > 0) {
        plans.push(plan);
      }
    });

    return plans;
  }

  isFillable(field) {
    if (field.disabled) return false;
    if (field.tag === 'button' || field.type === 'submit' || field.type === 'hidden') return false;
    return true;
  }

  classifyField(field) {
    const evidence = [
      field.label,
      field.name,
      field.id,
      field.placeholder,
      field.ariaLabel,
      field.ariaDescribedBy,
      field.fieldset_legend,
      field.context
    ].filter(Boolean).join(' ');

    let bestMatch = null;
    let highestScore = 0;

    SEMANTIC_PATTERNS.forEach(pattern => {
      const match = evidence.match(pattern.regex);
      if (match) {
        // Boost score if matched in more critical attributes (like name or label vs just nearby text)
        let score = pattern.weight;
        if (field.name && field.name.match(pattern.regex)) score += 0.5;
        if (field.label && field.label.match(pattern.regex)) score += 0.5;
        if (field.id && field.id.match(pattern.regex)) score += 0.4;
        
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
      'password': SymbolicSecretSource.LOCAL_PASSWORD,
      'address_line1': SymbolicSecretSource.LOCAL_ADDRESS,
      'pan': SymbolicSecretSource.LOCAL_PAN,
      'aadhaar': SymbolicSecretSource.LOCAL_AADHAAR
    };
    return map[semanticType] || SymbolicSecretSource.LOCAL_PROFILE;
  }
}

export const defaultFormAnalyzer = new FormAnalyzer();
