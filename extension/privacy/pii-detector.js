/**
 * Local Deterministic & Contextual PII Detector
 * Runs strictly client-side to detect Indian Government IDs, Passwords,
 * Financial details, and personal data.
 */

import { PIICategory, SymbolicSecretSource } from '../shared/constants.js';

// Verhoeff Algorithm for Aadhaar Validation
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];

export function validateAadhaarVerhoeff(numStr) {
  const clean = String(numStr).replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(clean)) return false;
  // Exclude impossible Aadhaar patterns (e.g., starting with 0 or 1)
  if (clean.startsWith('0') || clean.startsWith('1')) return false;

  let c = 0;
  const invertedArray = clean.split('').map(Number).reverse();
  for (let i = 0; i < invertedArray.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][invertedArray[i]]];
  }
  return c === 0;
}

// Luhn Algorithm for Credit/Debit Cards
export function validateLuhn(cardStr) {
  const clean = String(cardStr).replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(clean)) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let digit = parseInt(clean.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export class PIIDetector {
  constructor() {
    this.panRegex = /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/i;
    this.aadhaarRegex = /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\s?\d)\b/;
    this.phoneRegex = /(?:(?:\+|0{0,2})91[\s-]?)?[6-9]\d{9}\b/;
    this.emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
    this.dobRegex = /\b(?:0[1-9]|[12][0-9]|3[01])[-/.](?:0[1-9]|1[012])[-/.](?:19|20)\d\d\b/;
    this.ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
    this.otpRegex = /\b\d{4,8}\b/;
  }

  /**
   * Scans a text value and identifies if it matches a PII category
   */
  detectPIIInText(text, contextHint = '') {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    // Check PAN
    if (this.panRegex.test(trimmed)) {
      return {
        category: PIICategory.PAN,
        source: SymbolicSecretSource.LOCAL_PAN,
        confidence: 0.98,
        match: trimmed.match(this.panRegex)[0]
      };
    }

    // Check Credit Card (13-19 digits with Luhn) before 12-digit Aadhaar
    const cardMatch = trimmed.match(/\b(?:\d[\s-]?){13,19}\b/);
    if (cardMatch) {
      const cleanDigits = cardMatch[0].replace(/[\s-]/g, '');
      if (validateLuhn(cleanDigits)) {
        return {
          category: PIICategory.CREDIT_CARD,
          source: SymbolicSecretSource.LOCAL_CREDIT_CARD,
          confidence: 0.95,
          match: cleanDigits
        };
      }
    }

    // Check Aadhaar (strictly 12 digits)
    const aadhaarMatch = trimmed.match(this.aadhaarRegex);
    if (aadhaarMatch) {
      const isChecksumValid = validateAadhaarVerhoeff(aadhaarMatch[0]);
      return {
        category: PIICategory.AADHAAR,
        source: SymbolicSecretSource.LOCAL_AADHAAR,
        confidence: isChecksumValid ? 0.99 : 0.85,
        match: aadhaarMatch[0]
      };
    }

    // Check Email
    const emailMatch = trimmed.match(this.emailRegex);
    if (emailMatch) {
      return {
        category: PIICategory.EMAIL,
        source: SymbolicSecretSource.LOCAL_EMAIL,
        confidence: 0.96,
        match: emailMatch[0]
      };
    }

    // Check Phone (specifically if context indicates mobile/phone or 10-digit Indian pattern)
    const phoneMatch = trimmed.match(this.phoneRegex);
    const safeHint = (contextHint || '').toLowerCase();
    if (phoneMatch && (safeHint.includes('phone') || safeHint.includes('mobile') || safeHint.includes('tel') || trimmed.startsWith('+91'))) {
      return {
        category: PIICategory.PHONE,
        source: SymbolicSecretSource.LOCAL_PHONE,
        confidence: 0.92,
        match: phoneMatch[0]
      };
    }

    // Check DOB
    const dobMatch = trimmed.match(this.dobRegex);
    if (dobMatch) {
      return {
        category: PIICategory.DOB,
        source: SymbolicSecretSource.LOCAL_DOB,
        confidence: 0.90,
        match: dobMatch[0]
      };
    }

    // Check OTP if context suggests OTP / Verification code
    if (/otp|code|pin|verification/i.test(contextHint) && this.otpRegex.test(trimmed)) {
      return {
        category: PIICategory.OTP,
        source: SymbolicSecretSource.LOCAL_PASSWORD,
        confidence: 0.88,
        match: trimmed
      };
    }

    return null;
  }
}

export const defaultPIIDetector = new PIIDetector();
