/**
 * Secret & Sensitive Field Detector
 * Inspects DOM attributes, input types, autocomplete, placeholders,
 * and associated labels to classify elements before values are ever entered.
 */

import { PIICategory, SymbolicSecretSource } from '../shared/constants.js';

export class SecretDetector {
  constructor() {
    this.sensitiveKeywords = [
      { pattern: /aadhaar|uidai|unique\s*id/i, category: PIICategory.AADHAAR, source: SymbolicSecretSource.LOCAL_AADHAAR },
      { pattern: /\bpan\b|pan\s*card|permanent\s*account/i, category: PIICategory.PAN, source: SymbolicSecretSource.LOCAL_PAN },
      { pattern: /password|passcode|secret|pin\b/i, category: PIICategory.PASSWORD, source: SymbolicSecretSource.LOCAL_PASSWORD },
      { pattern: /otp|one\s*time\s*pass|verification\s*code/i, category: PIICategory.OTP, source: SymbolicSecretSource.LOCAL_PASSWORD },
      { pattern: /card\s*number|cardnum|cc_num|credit\s*card|debit\s*card/i, category: PIICategory.CREDIT_CARD, source: SymbolicSecretSource.LOCAL_CREDIT_CARD },
      { pattern: /\bcvv\b|\bcvc\b|security\s*code/i, category: PIICategory.CVV, source: SymbolicSecretSource.LOCAL_CVV },
      { pattern: /bank\s*acc|account\s*num|ifsc/i, category: PIICategory.BANK_ACCOUNT, source: SymbolicSecretSource.LOCAL_PROFILE },
      { pattern: /phone|mobile|cell|contact\s*num/i, category: PIICategory.PHONE, source: SymbolicSecretSource.LOCAL_PHONE },
      { pattern: /email|e-mail/i, category: PIICategory.EMAIL, source: SymbolicSecretSource.LOCAL_EMAIL },
      { pattern: /\bdob\b|date\s*of\s*birth|birth\s*date/i, category: PIICategory.DOB, source: SymbolicSecretSource.LOCAL_DOB },
      { pattern: /full\s*name|applicant\s*name|first\s*name|last\s*name/i, category: PIICategory.FULL_NAME, source: SymbolicSecretSource.LOCAL_FULL_NAME },
      { pattern: /address|residential\s*address|pincode|postal\s*code/i, category: PIICategory.ADDRESS, source: SymbolicSecretSource.LOCAL_ADDRESS },
      { pattern: /upload\s*(aadhaar|pan|id|document|passport|pdf)/i, category: PIICategory.DOCUMENT, source: SymbolicSecretSource.LOCAL_DOCUMENT }
    ];
  }

  /**
   * Evaluates an element's structural attributes to determine if it is a sensitive field.
   * @param {Object} elementMetadata - Attributes like { type, name, id, placeholder, label, ariaLabel, autocomplete }
   */
  classifyElement(elementMetadata = {}) {
    const type = (elementMetadata?.type || '').toLowerCase();
    const name = (elementMetadata?.name || '').toLowerCase();
    const id = (elementMetadata?.id || '').toLowerCase();
    const placeholder = (elementMetadata?.placeholder || '').toLowerCase();
    const label = (elementMetadata?.label || '').toLowerCase();
    const ariaLabel = (elementMetadata?.ariaLabel || '').toLowerCase();
    const autoLower = (elementMetadata?.autocomplete || '').toLowerCase();

    // 1. Definite password type
    if (type === 'password') {
      return {
        isSensitive: true,
        category: PIICategory.PASSWORD,
        source: SymbolicSecretSource.LOCAL_PASSWORD,
        reason: 'input[type=password]'
      };
    }

    // 2. Autocomplete attribute hints
    if (autoLower.includes('current-password') || autoLower.includes('new-password')) {
      return {
        isSensitive: true,
        category: PIICategory.PASSWORD,
        source: SymbolicSecretSource.LOCAL_PASSWORD,
        reason: 'autocomplete=password'
      };
    }
    if (autoLower.includes('cc-number')) {
      return {
        isSensitive: true,
        category: PIICategory.CREDIT_CARD,
        source: SymbolicSecretSource.LOCAL_CREDIT_CARD,
        reason: 'autocomplete=cc-number'
      };
    }
    if (autoLower.includes('cc-csc')) {
      return {
        isSensitive: true,
        category: PIICategory.CVV,
        source: SymbolicSecretSource.LOCAL_CVV,
        reason: 'autocomplete=cc-csc'
      };
    }

    // 3. File upload fields for identity documents
    if (type === 'file') {
      const combinedDocText = `${name} ${id} ${placeholder} ${label} ${ariaLabel}`;
      if (/aadhaar|pan|id|identity|passport|document|kyc/i.test(combinedDocText)) {
        return {
          isSensitive: true,
          category: PIICategory.DOCUMENT,
          source: SymbolicSecretSource.LOCAL_DOCUMENT,
          reason: 'file_upload_identity'
        };
      }
    }

    // 4. Keyword heuristic matching across name, id, placeholder, label, aria-label
    const corpus = `${name} ${id} ${placeholder} ${label} ${ariaLabel}`;
    for (const entry of this.sensitiveKeywords) {
      if (entry.pattern.test(corpus)) {
        return {
          isSensitive: true,
          category: entry.category,
          source: entry.source,
          reason: `keyword_match:${entry.category}`
        };
      }
    }

    return {
      isSensitive: false,
      category: null,
      source: null,
      reason: 'non_sensitive'
    };
  }
}

export const defaultSecretDetector = new SecretDetector();
