/**
 * Shared, locally evaluated PII rules.
 *
 * Keep recognition in one place so the DOM sanitizer and outbound policy use
 * the same patterns. Region-specific patterns are conservative heuristics,
 * not proof that a value is valid or belongs to a particular person.
 */
import { PIICategory, SymbolicSecretSource } from '../shared/constants.js';

export function validateLuhnDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 2) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function validateNhsNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(digits)) return false;
  const sum = digits.slice(0, 9).split('').reduce((total, digit, index) => total + Number(digit) * (10 - index), 0);
  const check = 11 - (sum % 11);
  if (check === 11) return digits[9] === '0';
  return check !== 10 && digits[9] === String(check);
}

export function validateIban(value) {
  const normalized = String(value || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalized)) return false;
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const expanded = char >= 'A' && char <= 'Z' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const CONTEXT_RULES = {
  // Phone context includes bare contact verbs so "call me at ..." and
  // "Contact Jane ... <number>" are caught without a "phone number" label.
  phone: /phone|mobile|telephone|\btel\b|contact|call|dial|whatsapp/i,
  ssn: /\b(?:ssn|social\s+security(?:\s+number)?)\b/i,
  sin: /\b(?:sin|social\s+insurance(?:\s+number)?)\b/i,
  nhs: /\bnhs(?:\s*(?:number|no\.?))?\b/i,
  iban: /\biban\b/i,
  ifsc: /\bifsc\b/i,
  dob: /\b(?:dob|date\s*of\s*birth|birth\s*date|born\s*on|birthday)\b/i,
  otp: /\b(?:otp|one[ -]?time(?:[ -]?(?:password|code))?|verification code|security code)\b/i,
  password: /\b(?:password|passcode|passphrase)\b/i,
  cvv: /\b(?:cvv|cvc|card verification)\b/i,
  bank_account: /\b(?:bank account|account number|acct(?:\s*(?:number|no\.?))?)\b/i
};

export const PII_RULES = [
  { id: 'AADHAAR', category: PIICategory.AADHAAR, source: SymbolicSecretSource.LOCAL_AADHAAR, pattern: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\s?\d)\b/g, confidence: 0.9 },
  { id: 'PAN', category: PIICategory.PAN, source: SymbolicSecretSource.LOCAL_PAN, pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi, confidence: 0.98 },
  { id: 'US_SSN', category: PIICategory.SSN, source: SymbolicSecretSource.LOCAL_SSN, pattern: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g, confidence: 0.96 },
  { id: 'US_SSN_COMPACT', category: PIICategory.SSN, source: SymbolicSecretSource.LOCAL_SSN, pattern: /\b(?!000|666|9\d\d)\d{3}(?!00)\d{2}(?!0000)\d{4}\b/g, context: 'ssn', confidence: 0.9 },
  { id: 'UK_NIN', category: PIICategory.NIN, source: SymbolicSecretSource.LOCAL_NIN, pattern: /\b(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z]{2}\s?\d{6}\s?[A-D]\b/gi, confidence: 0.9 },
  { id: 'CANADA_SIN', category: PIICategory.SIN, source: SymbolicSecretSource.LOCAL_SIN, pattern: /\b\d{3}[ -]?\d{3}[ -]?\d{3}\b/g, context: 'sin', validate: validateLuhnDigits, confidence: 0.88 },
  { id: 'UK_NHS', category: PIICategory.NHS, source: SymbolicSecretSource.LOCAL_NHS, pattern: /\b\d{3}[ -]?\d{3}[ -]?\d{4}\b/g, context: 'nhs', validate: validateNhsNumber, confidence: 0.92 },
  { id: 'IBAN', category: PIICategory.IBAN, source: SymbolicSecretSource.LOCAL_IBAN, pattern: /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/gi, context: 'iban', validate: validateIban, confidence: 0.98 },
  { id: 'CREDIT_CARD', category: PIICategory.CREDIT_CARD, source: SymbolicSecretSource.LOCAL_CREDIT_CARD, pattern: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, validate: validateLuhnDigits, confidence: 0.95 },
  { id: 'EMAIL', category: PIICategory.EMAIL, source: SymbolicSecretSource.LOCAL_EMAIL, pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, confidence: 0.96 },
  { id: 'PHONE_IN', category: PIICategory.PHONE, source: SymbolicSecretSource.LOCAL_PHONE, pattern: /(?<!\d)(?:(?:\+|0{0,2})91[\s-]?)?[6-9]\d{9}(?!\d)/g, context: 'phone', confidence: 0.92 },
  { id: 'PHONE_INTL', category: PIICategory.PHONE, source: SymbolicSecretSource.LOCAL_PHONE, pattern: /(?<!\w)\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d(?:[ .-]?\d){6,12}(?!\w)/g, confidence: 0.9 },
  { id: 'DOB_DMY', category: PIICategory.DOB, source: SymbolicSecretSource.LOCAL_DOB, pattern: /\b(?:0[1-9]|[12]\d|3[01])[-/.](?:0[1-9]|1[0-2])[-/.](?:19|20)\d{2}\b/g, context: 'dob', confidence: 0.9 },
  { id: 'DOB_MDY', category: PIICategory.DOB, source: SymbolicSecretSource.LOCAL_DOB, pattern: /\b(?:0[1-9]|1[0-2])[-/.](?:0[1-9]|[12]\d|3[01])[-/.](?:19|20)\d{2}\b/g, context: 'dob', confidence: 0.86 },
  { id: 'IFSC', category: PIICategory.IFSC, source: SymbolicSecretSource.LOCAL_PROFILE, pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi, context: 'ifsc', confidence: 0.9 }
  ,{ id: 'OTP', category: PIICategory.OTP, source: SymbolicSecretSource.LOCAL_PASSWORD, pattern: /\b(?:\d{4,10}|[A-Z0-9]{6,10})\b/gi, context: 'otp', confidence: 0.9 }
  ,{ id: 'PASSWORD_TEXT', category: PIICategory.PASSWORD, source: SymbolicSecretSource.LOCAL_PASSWORD, pattern: /\b(?:password|passcode|passphrase)\s*(?::|=|\bis\s+)(?!required\b|incorrect\b|invalid\b|blank\b|empty\b|not\b)[A-Za-z0-9!@#$%^&*._+~-]{3,64}\b/gi, context: 'password', confidence: 0.9 }
  ,{ id: 'CVV', category: PIICategory.CVV, source: SymbolicSecretSource.LOCAL_CVV, pattern: /\b\d{3,4}\b/g, context: 'cvv', confidence: 0.92 }
  ,{ id: 'BANK_ACCOUNT', category: PIICategory.BANK_ACCOUNT, source: SymbolicSecretSource.LOCAL_PROFILE, pattern: /\b(?:\d[ -]?){8,18}(?!\d)/g, context: 'bank_account', confidence: 0.88 }
];

/**
 * Unconditional rules bypass context gating entirely. Only patterns with
 * extremely low false-positive rates belong here. PHONE_IN was removed
 * because its broad 10-digit regex caused massive false positives on order
 * IDs, product codes, and tracking numbers; it now relies on the phone
 * context (field label OR a nearby trigger word). IFSC's checksum-shaped
 * pattern (4 letters + 0 + 6 alphanumerics) stays unconditional.
 */
const UNCONDITIONAL_IDS = new Set(['IFSC']);

/** Register an additional locally evaluated rule before making requests. */
export function registerPIIRule(rule) {
  if (!rule || !/^[A-Z][A-Z0-9_]{1,48}$/.test(String(rule.id || '')) ||
      !/^[A-Z][A-Z0-9_]{1,48}$/.test(String(rule.category || '')) ||
      !(rule.pattern instanceof RegExp) ||
      (rule.context && !(rule.context instanceof RegExp) && !Object.hasOwn(CONTEXT_RULES, rule.context))) {
    throw new Error('A PII rule requires an uppercase id/category and a RegExp pattern.');
  }
  if (PII_RULES.some((existing) => existing.id === rule.id)) throw new Error('PII rule already registered: ' + rule.id);
  PII_RULES.push({ confidence: 0.8, ...rule });
}

// Context triggers must sit near the match itself, not merely anywhere in a
// large payload: a "phone" word 100KB away must not redact every 10-digit
// number in the payload.
const PROXIMITY_WINDOW = 60;

function hasNearbyTrigger(text, index, length, contextPattern) {
  if (!contextPattern) return false;
  const re = new RegExp(contextPattern.source, contextPattern.flags.replace(/g/g, ''));
  const start = Math.max(0, index - PROXIMITY_WINDOW);
  const end = Math.min(text.length, index + length + PROXIMITY_WINDOW);
  return re.test(text.slice(start, end));
}

const DECIMAL_BLOCK_STARTS = [
  0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66,
  0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20,
  0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90,
  0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0,
  0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30, 0x11066, 0x110f0,
  0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0,
  0x11730, 0x118e0, 0x11950, 0x11c50, 0x11d50, 0x11da0, 0x16a60,
  0x16ac0, 0x16b50, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6,
  0x1e140, 0x1e2f0, 0x1e4f0, 0x1e950
];

/** NFKC plus zero-width/format removal, retaining offsets into the source. */
function canonicalizeWithOffsets(source) {
  let canonical = '';
  const starts = [];
  const ends = [];
  let originalOffset = 0;
  for (const originalChar of source) {
    const originalStart = originalOffset;
    originalOffset += originalChar.length;
    const normalized = originalChar.normalize('NFKC').replace(/[\p{Cf}]/gu, '');
    for (const char of normalized) {
      let normalizedChar = char;
      const point = char.codePointAt(0);
      if (/\p{Nd}/u.test(char)) {
        const block = DECIMAL_BLOCK_STARTS.find((start) => point >= start && point < start + 10);
        if (block !== undefined) normalizedChar = String(point - block);
      }
      canonical += normalizedChar;
      for (let i = 0; i < normalizedChar.length; i++) {
        starts.push(originalStart);
        ends.push(originalOffset);
      }
    }
  }
  return { text: canonical, starts, ends };
}

export function findPIIMatches(text, contextHint = '') {
  if (typeof text !== 'string' || !text) return [];
  const canonical = canonicalizeWithOffsets(text);
  // A non-empty hint is FIELD-level context (label/name). An absent hint
  // (policy engine, raw text) must not degrade into payload-wide context —
  // gated rules then rely on proximity to the match alone.
  const hasFieldContext = typeof contextHint === 'string' && contextHint.trim().length > 0;
  const context = hasFieldContext ? canonicalizeWithOffsets(contextHint).text : '';
  const matches = [];
  for (const rule of PII_RULES) {
    const contextPattern = rule.context instanceof RegExp ? rule.context : CONTEXT_RULES[rule.context];
    // Unconditional rules skip gating; gated rules fire when the trigger is
    // in the FIELD context or near the match itself.
    const contextOk = !rule.context || UNCONDITIONAL_IDS.has(rule.id) || (
      hasFieldContext && contextPattern &&
      new RegExp(contextPattern.source, contextPattern.flags.replace(/g/g, '')).test(context)
    );
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g';
    const pattern = new RegExp(rule.pattern.source, flags);
    for (const match of canonical.text.matchAll(pattern)) {
      if (rule.validate) {
        try { if (!rule.validate(match[0])) continue; }
        catch { /* validator failure fails closed: redact the pattern match */ }
      }
      if (!contextOk && !hasNearbyTrigger(canonical.text, match.index, match[0].length, contextPattern)) continue;
      const sourceStart = canonical.starts[match.index] ?? match.index;
      const sourceEnd = canonical.ends[Math.max(match.index, match.index + match[0].length - 1)] ?? (match.index + match[0].length);
      if (sourceEnd <= sourceStart) continue;
      matches.push({
        id: rule.id,
        category: rule.category,
        source: rule.source,
        confidence: rule.confidence,
        value: text.slice(sourceStart, sourceEnd),
        index: sourceStart,
        end: sourceEnd
      });
    }
  }
  matches.sort((a, b) => a.index - b.index || b.end - a.end);
  return matches;
}

export function redactPII(text, contextHint = '') {
  const matches = findPIIMatches(text, contextHint);
  if (!matches.length) return text;
  let result = '';
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue;
    result += text.slice(cursor, match.index) + `[REDACTED_${match.category}]`;
    cursor = match.end;
  }
  return result + text.slice(cursor);
}
