/**
 * Secret & Sensitive Field Detector
 * Inspects DOM attributes, input types, autocomplete, placeholders,
 * and associated labels to classify elements before values are ever entered.
 */

import { PIICategory, SymbolicSecretSource } from '../shared/constants.js';

export class SecretDetector {
  constructor() {
    this.sensitiveKeywords = [
      { pattern: /aadhaar|aadhar|uidai|\buid\b|unique\s*id/i, category: PIICategory.AADHAAR, source: SymbolicSecretSource.LOCAL_AADHAAR },
      { pattern: /\b(?:ssn|social\s*security(?:\s*number)?)\b/i, category: PIICategory.SSN, source: SymbolicSecretSource.LOCAL_SSN },
      { pattern: /\b(?:sin|social\s*insurance(?:\s*number)?)\b/i, category: PIICategory.SIN, source: SymbolicSecretSource.LOCAL_SIN },
      { pattern: /\b(?:nin|national\s*insurance(?:\s*number)?)\b/i, category: PIICategory.NIN, source: SymbolicSecretSource.LOCAL_NIN },
      { pattern: /\bnhs(?:\s*(?:number|no\.?))?\b/i, category: PIICategory.NHS, source: SymbolicSecretSource.LOCAL_NHS },
      { pattern: /\biban\b/i, category: PIICategory.IBAN, source: SymbolicSecretSource.LOCAL_IBAN },
      { pattern: /\bpassport(?:\s*(?:number|no\.?))?\b/i, category: PIICategory.PASSPORT, source: SymbolicSecretSource.LOCAL_PROFILE },
      { pattern: /\b(?:driver.?s?.?licen[cs]e|driving.?licen[cs]e|national.?id(?:entity)?(?:.?number)?|tax.?id(?:.?number)?)\b/i, category: PIICategory.DOCUMENT, source: SymbolicSecretSource.LOCAL_PROFILE },
      { pattern: /\bpan\b|pan\s*card|permanent\s*account/i, category: PIICategory.PAN, source: SymbolicSecretSource.LOCAL_PAN },
      { pattern: /password|passcode|secret|pin\b/i, category: PIICategory.PASSWORD, source: SymbolicSecretSource.LOCAL_PASSWORD },
      { pattern: /otp|one\s*time\s*pass|verification\s*code/i, category: PIICategory.OTP, source: SymbolicSecretSource.LOCAL_PASSWORD },
      { pattern: /card\s*number|cardnum|cc_num|credit\s*card|debit\s*card/i, category: PIICategory.CREDIT_CARD, source: SymbolicSecretSource.LOCAL_CREDIT_CARD },
      { pattern: /\bcvv\b|\bcvc\b|security\s*code/i, category: PIICategory.CVV, source: SymbolicSecretSource.LOCAL_CVV },
      { pattern: /bank\s*acc|account\s*num|ifsc/i, category: PIICategory.BANK_ACCOUNT, source: SymbolicSecretSource.LOCAL_PROFILE },
      { pattern: /phone|mobile|telephone|\btel\b|whatsapp|cell|contact\s*num/i, category: PIICategory.PHONE, source: SymbolicSecretSource.LOCAL_PHONE },
      { pattern: /email|e-mail/i, category: PIICategory.EMAIL, source: SymbolicSecretSource.LOCAL_EMAIL },
      { pattern: /\bdob\b|date\s*of\s*birth|birth\s*date|birth\s*year|born(?:\s*on)?\b/i, category: PIICategory.DOB, source: SymbolicSecretSource.LOCAL_DOB },
      // Include standalone "name" labels used by short forms. Word boundaries
      // avoid matching unrelated values such as username or filename (see the
      // compound-name guard in classifyElement). Holder phrasing ("account
      // holder name", "name on card") is the user's own name on the account.
      { pattern: /\b(full\s*name|applicant\s*name|candidate\s*name|first\s*name|last\s*name|surname|family\s*name|given\s*name|middle\s*name|your\s*name|account\s*holder(\s*name)?|card\s*holder|name\s*on\s*card|name)\b/i, category: PIICategory.FULL_NAME, source: SymbolicSecretSource.LOCAL_FULL_NAME },
      { pattern: /address|residential\s*address|permanent\s*address|present\s*address|correspondence\s*address|communication\s*address|office\s*address|current\s*address|\baddr(?:ess)?[\s_-]*(?:line[\s_-]*)?[123]?\b|street(?:[\s_-]*address)?(?:[\s_-]*[123])?|house\s*(?:no\.?|number)|door\s*(?:no\.?|number)|flat|apartment|\bapt\b|building|\bunit\b|locality|landmark|pincode|pin\s*code|postal\s*(?:code)?|post\s*code|postcode|zip(?:\s*code|code)?/i, category: PIICategory.ADDRESS, source: SymbolicSecretSource.LOCAL_ADDRESS },
      { pattern: /\b(gender|sex)\b/i, category: PIICategory.GENDER, source: SymbolicSecretSource.LOCAL_GENDER },
      { pattern: /\b(country|nation|citizenship|nationality)\b/i, category: PIICategory.COUNTRY, source: SymbolicSecretSource.LOCAL_COUNTRY },
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

    if (type === 'email' || autoLower.includes('email')) {
      return { isSensitive: true, category: PIICategory.EMAIL, source: SymbolicSecretSource.LOCAL_EMAIL, reason: 'email_control' };
    }
    if (type === 'tel' || autoLower.includes('tel')) {
      return { isSensitive: true, category: PIICategory.PHONE, source: SymbolicSecretSource.LOCAL_PHONE, reason: 'telephone_control' };
    }
    if (/^(?:name|given-name|additional-name|family-name)$/.test(autoLower.trim())) {
      return { isSensitive: true, category: PIICategory.FULL_NAME, source: SymbolicSecretSource.LOCAL_FULL_NAME, reason: 'autocomplete=name' };
    }
    if (autoLower.includes('bday')) {
      return { isSensitive: true, category: PIICategory.DOB, source: SymbolicSecretSource.LOCAL_DOB, reason: 'autocomplete=bday' };
    }
    // Address autocomplete tokens are unambiguous regardless of label wording.
    if (autoLower.includes('street-address') || autoLower.includes('address-line')) {
      return { isSensitive: true, category: PIICategory.ADDRESS, source: SymbolicSecretSource.LOCAL_ADDRESS, reason: 'autocomplete=street-address' };
    }
    // The standard address-level tokens describe city/state/province parts of
    // a home or delivery address and remain meaningful even with no label.
    if (/\baddress-level[1-4]\b/.test(autoLower)) {
      return { isSensitive: true, category: PIICategory.ADDRESS, source: SymbolicSecretSource.LOCAL_ADDRESS, reason: 'autocomplete=address-level' };
    }
    if (autoLower.includes('postal-code') || autoLower.includes('zip')) {
      return { isSensitive: true, category: PIICategory.ADDRESS, source: SymbolicSecretSource.LOCAL_ADDRESS, reason: 'autocomplete=postal-code' };
    }
    if (autoLower.includes('country')) {
      return { isSensitive: true, category: PIICategory.COUNTRY, source: SymbolicSecretSource.LOCAL_COUNTRY, reason: 'autocomplete=country' };
    }
    if (autoLower === 'sex') {
      return { isSensitive: true, category: PIICategory.GENDER, source: SymbolicSecretSource.LOCAL_GENDER, reason: 'autocomplete=sex' };
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

    // 4. Postal PIN-code guard (runs BEFORE the keyword loop): a "PIN"
    // next to postal context (pincode / postal / zip / "PIN / ZIP") is a
    // postal code, not a password/security PIN. Bare "PIN" (ATM PIN,
    // UPI PIN, "Enter PIN") still falls through to the PASSWORD rule.
    const corpus = `${name} ${id} ${placeholder} ${label} ${ariaLabel}`;
    if (/\bpin\b/i.test(corpus) && /\b(pin\s*code|pincode|postal(\s*code)?|zip(\s*code)?|pin\s*\/\s*zip)\b/i.test(corpus)) {
      return {
        isSensitive: false,
        category: null,
        source: null,
        reason: 'postal_pin_not_secret'
      };
    }

    // 5. Compound-identifier guard: the page controls
    // `name`/`id`, so "user name", "login name", "display name" or "file name"
    // is a username/handle or an upload control — never the user's legal name.
    // "Account holder name" is unaffected ("holder" intervenes), as are
    // "applicant/candidate/full name". Only the FULL_NAME entry is skipped;
    // other keywords (e.g. "account number" -> BANK_ACCOUNT) still apply.
    const compoundName = /\b(?:user|login|account|file|image|domain|host|display|nick|screen|project|product|item|page|site|app|company|brand|db|field)\s?name\b/i.test(corpus);

    // 6. Keyword heuristic matching across name, id, placeholder, label, aria-label
    for (const entry of this.sensitiveKeywords) {
      if (entry.category === PIICategory.FULL_NAME && compoundName) continue;
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
