/**
 * System-wide Constants for the Privacy-Preserving Agentic Browser
 */

export const AgentState = Object.freeze({
  IDLE: 'IDLE',
  UNDERSTANDING_TASK: 'UNDERSTANDING_TASK',
  OBSERVING: 'OBSERVING',
  SANITIZING: 'SANITIZING',
  VISUAL_ANALYSIS: 'VISUAL_ANALYSIS',
  REASONING: 'REASONING',
  PLANNING: 'PLANNING',
  VALIDATING_ACTION: 'VALIDATING_ACTION',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  WAITING_FOR_USER: 'WAITING_FOR_USER',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

export const ActionType = Object.freeze({
  NAVIGATE: 'NAVIGATE',
  CLICK: 'CLICK',
  TYPE: 'TYPE',
  SELECT: 'SELECT',
  CHECK: 'CHECK',
  UNCHECK: 'UNCHECK',
  SCROLL: 'SCROLL',
  HOVER: 'HOVER',
  WAIT: 'WAIT',
  PRESS_KEY: 'PRESS_KEY',
  UPLOAD: 'UPLOAD',
  EXTRACT: 'EXTRACT',
  GO_BACK: 'GO_BACK',
  GO_FORWARD: 'GO_FORWARD',
  OPEN_TAB: 'OPEN_TAB',
  SWITCH_TAB: 'SWITCH_TAB',
  ASK_USER: 'ASK_USER',
  SUBMIT: 'SUBMIT',
  DONE: 'DONE',
  FILL_FORM_PLAN: 'FILL_FORM_PLAN'
});

// Message types live in shared/messages.js (single source of truth) so the
// two copies cannot drift apart.

export const RiskLevel = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL'
});

export const SymbolicSecretSource = Object.freeze({
  LOCAL_AADHAAR: 'LOCAL_AADHAAR',
  LOCAL_PAN: 'LOCAL_PAN',
  LOCAL_FULL_NAME: 'LOCAL_FULL_NAME',
  LOCAL_DOB: 'LOCAL_DOB',
  LOCAL_PHONE: 'LOCAL_PHONE',
  LOCAL_EMAIL: 'LOCAL_EMAIL',
  LOCAL_ADDRESS: 'LOCAL_ADDRESS',
  LOCAL_CITY: 'LOCAL_CITY',
  LOCAL_STATE: 'LOCAL_STATE',
  LOCAL_ZIP: 'LOCAL_ZIP',
  LOCAL_PASSWORD: 'LOCAL_PASSWORD',
  LOCAL_DOCUMENT: 'LOCAL_DOCUMENT',
  LOCAL_CREDIT_CARD: 'LOCAL_CREDIT_CARD',
  LOCAL_CVV: 'LOCAL_CVV',
  LOCAL_PROFILE: 'LOCAL_PROFILE',
  LOCAL_COUNTRY: 'LOCAL_COUNTRY',
  LOCAL_GENDER: 'LOCAL_GENDER',
  LOCAL_TERMS: 'LOCAL_TERMS',
  LOCAL_SSN: 'LOCAL_SSN',
  LOCAL_SIN: 'LOCAL_SIN',
  LOCAL_NIN: 'LOCAL_NIN',
  LOCAL_NHS: 'LOCAL_NHS',
  LOCAL_IBAN: 'LOCAL_IBAN'
});

// ── Named vault documents ─────────────────────────────────────────────────
//
// A user can pre-store an identity document in the local vault under a name of
// their choosing ("aadhar", "pan", "passport"). The model never sees or names a
// file: it selects one of these tokens, and only a token the user created can
// ever resolve.
//
// The name is a SECURITY BOUNDARY, not a label. It travels to the remote model
// inside prompts and action JSON, and it is the only handle on the stored
// bytes, so the charset is restricted to uppercase letters, digits and
// underscores with a hard length bound. Nothing in this format can express a
// path, a directory, a glob, or a file id — there is no API anywhere that
// takes a local path, so "read an arbitrary local file" is unrepresentable
// rather than merely disallowed.
export const DOCUMENT_NAME_PREFIX = 'LOCAL_DOCUMENT_';
export const DOCUMENT_NAME_PATTERN = /^LOCAL_DOCUMENT_[A-Z0-9_]{1,48}$/;
/** Documents are capped so one file cannot exhaust the encrypted store. */
export const MAX_VAULT_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** True only for a well-formed `LOCAL_DOCUMENT_<NAME>` token. */
export function isDocumentToken(value) {
  return typeof value === 'string' && DOCUMENT_NAME_PATTERN.test(value);
}

export const PIICategory = Object.freeze({
  AADHAAR: 'AADHAAR',
  PAN: 'PAN',
  PASSPORT: 'PASSPORT',
  PASSWORD: 'PASSWORD',
  OTP: 'OTP',
  CREDIT_CARD: 'CREDIT_CARD',
  CVV: 'CVV',
  BANK_ACCOUNT: 'BANK_ACCOUNT',
  PHONE: 'PHONE',
  EMAIL: 'EMAIL',
  DOB: 'DOB',
  FULL_NAME: 'FULL_NAME',
  ADDRESS: 'ADDRESS',
  GENDER: 'GENDER',
  COUNTRY: 'COUNTRY',
  DOCUMENT: 'DOCUMENT',
  SSN: 'SSN',
  SIN: 'SIN',
  NIN: 'NIN',
  NHS: 'NHS',
  IBAN: 'IBAN',
  IFSC: 'IFSC'
});

export const ServerDefaults = Object.freeze({
  BACKEND_BASE_URL: 'http://localhost:8000',
  VISION_ENDPOINT: '/vision',
  REASON_ENDPOINT: '/reason',
  MAX_STEPS_DEFAULT: 25,
  STABILITY_WAIT_MS: 400
});
