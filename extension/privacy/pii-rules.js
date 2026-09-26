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
  phone: /phone|mobile|telephone|tel\b|contact\s*(?:number|no\.?)/i,
  ssn: /\b(?:ssn|social\s+security(?:\s+number)?)\b/i,
  sin: /\b(?:sin|social\s+insurance(?:\s+number)?)\b/i,
  nhs: /\bnhs(?:\s*(?:number|no\.?))?\b/i,
  iban: /\biban\b/i,
  ifsc: /\bifsc\b/i
};

export const PII_RULES = [
  { id: 'AADHAAR', category: PIICategory.AADHAAR, source: SymbolicSecretSource.LOCAL_AADHAAR, pattern: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\s?\d)\b/g, confidence: 0.9 },
  { id: 'PAN', category: PIICategory.PAN, source: SymbolicSecretSource.LOCAL_PAN, pattern: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi, confidence: 0.98 },
  { id: 'US_SSN', category: PIICategory.SSN, source: SymbolicSecretSource.LOCAL_SSN, pattern: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g, confidence: 0.96 },
  { id: 'US_SSN_COMPACT', category: PIICategory.SSN, source: SymbolicSecretSource.LOCAL_SSN, pattern: /\b(?!000|666|9\d\d)\d{3}(?!00)\d{2}(?!0000)\d{4}\b/g, context: 'ssn', confidence: 0.9 },
  { id: 'UK_NIN', category: PIICategory.NIN, source: SymbolicSecretSource.LOCAL_NIN, pattern: /\b(?!BG|GB|KN|NK|NT|TN|ZZ)[A-CEGHJ-PR-TW-Z]{2}\s?\d{6}\s?[A-D]\b/gi, confidence: 0.9 },
  { id: 'CANADA_SIN', category: PIICategory.SIN, source: SymbolicSecretSource.LOCAL_SIN, pattern: /\b\d{3}[ -]?\d{3}[ -]?\d{3}\b/g, context: 'sin', validate: validateLuhnDigits, confidence: 0.88 },
  { id: 'UK_NHS', category: PIICategory.NHS, source: SymbolicSecretSource.LOCAL_NHS, pattern: /\b\d{3}[ -]?\d{3}[ -]?\d{4}\b/g, context: 'nhs', validate: validateNhsNumber, confidence: 0.92 },
  { id: 'IBAN', category: PIICategory.IBAN, source: SymbolicSecretSource.LOCAL_IBAN, pattern: /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/gi, validate: validateIban, confidence: 0.98 },
  { id: 'CREDIT_CARD', category: PIICategory.CREDIT_CARD, source: SymbolicSecretSource.LOCAL_CREDIT_CARD, pattern: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, validate: validateLuhnDigits, confidence: 0.95 },
  { id: 'EMAIL', category: PIICategory.EMAIL, source: SymbolicSecretSource.LOCAL_EMAIL, pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, confidence: 0.96 },
  { id: 'PHONE_IN', category: PIICategory.PHONE, source: SymbolicSecretSource.LOCAL_PHONE, pattern: /(?<!\d)(?:(?:\+|0{0,2})91[\s-]?)?[6-9]\d{9}(?!\d)/g, context: 'phone', confidence: 0.92 },
  { id: 'PHONE_INTL', category: PIICategory.PHONE, source: SymbolicSecretSource.LOCAL_PHONE, pattern: /(?<!\w)\+\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d(?:[ .-]?\d){6,12}(?!\w)/g, confidence: 0.9 },
  { id: 'DOB_DMY', category: PIICategory.DOB, source: SymbolicSecretSource.LOCAL_DOB, pattern: /\b(?:0[1-9]|[12]\d|3[01])[-/.](?:0[1-9]|1[0-2])[-/.](?:19|20)\d{2}\b/g, confidence: 0.9 },
  { id: 'DOB_MDY', category: PIICategory.DOB, source: SymbolicSecretSource.LOCAL_DOB, pattern: /\b(?:0[1-9]|1[0-2])[-/.](?:0[1-9]|[12]\d|3[01])[-/.](?:19|20)\d{2}\b/g, confidence: 0.86 },
  { id: 'IFSC', category: PIICategory.IFSC, source: SymbolicSecretSource.LOCAL_PROFILE, pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi, context: 'ifsc', confidence: 0.9 }
];

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

export function findPIIMatches(text, contextHint = '') {
  if (typeof text !== 'string' || !text) return [];
  const context = String(contextHint || text);
  const matches = [];
  for (const rule of PII_RULES) {
    const contextPattern = rule.context instanceof RegExp ? rule.context : CONTEXT_RULES[rule.context];
    if (rule.context && (!contextPattern || !new RegExp(contextPattern.source, contextPattern.flags.replace(/g/g, '')).test(context))) continue;
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g';
    const pattern = new RegExp(rule.pattern.source, flags);
    for (const match of text.matchAll(pattern)) {
      if (rule.validate) {
        try { if (!rule.validate(match[0])) continue; }
        catch { /* validator failure fails closed: redact the pattern match */ }
      }
      matches.push({
        id: rule.id,
        category: rule.category,
        source: rule.source,
        confidence: rule.confidence,
        value: match[0],
        index: match.index,
        end: match.index + match[0].length
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
