/**
 * Local deterministic/contextual detector using the shared PII rule registry.
 */

import { PIICategory, SymbolicSecretSource } from '../shared/constants.js';
import { findPIIMatches, validateLuhnDigits } from './pii-rules.js';

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
  return validateLuhnDigits(clean);
}

export class PIIDetector {
  constructor() {
    this.otpRegex = /\b\d{4,8}\b/;
  }

  /**
   * Scans a text value and identifies if it matches a PII category
   */
  detectPIIInText(text, contextHint = '') {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    const match = findPIIMatches(trimmed, contextHint)[0];
    if (match) {
      const confidence = match.id === 'AADHAAR'
        ? (validateAadhaarVerhoeff(match.value) ? 0.99 : 0.85)
        : match.confidence;
      return {
        category: match.category,
        source: match.source,
        confidence,
        match: match.value
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
