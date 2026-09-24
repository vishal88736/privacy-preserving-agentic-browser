/**
 * Local DOM Sanitizer
 * Strips sensitive values, masks PII, and assigns symbolic source tokens
 * before the DOM representation can be sent to remote models.
 *
 * L9: Expanded sensitive URL parameters
 * L10: Visible text is now scanned for email, phone, and credit card patterns
 * L13: PAN regex is now case-insensitive
 */

import { defaultPIIDetector, validateLuhn } from './pii-detector.js';
import { defaultSecretDetector } from './secret-detector.js';
import { defaultLocalVault } from './local-vault.js';
import { SymbolicSecretSource } from '../shared/constants.js';

export class DOMSanitizer {
  constructor(piiDetector = defaultPIIDetector, secretDetector = defaultSecretDetector, vault = null) {
    this.piiDetector = piiDetector;
    this.secretDetector = secretDetector;
    // Vault is consulted ONLY to scrub page-authored example text (placeholders)
    // that happens to match a secret. Real user values are handled via [REDACTED].
    this.vault = vault;
  }

  _vaultSecrets() {
    try {
      const store = this.vault || defaultLocalVault;
      return Object.values(store.getAllSecretsForUI()).filter((v) => typeof v === 'string');
    } catch {
      return [];
    }
  }

  _escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Replaces whole-token occurrences of a vault secret inside page-authored
   * text. Word-boundary + case-sensitive matching prevents corrupting
   * structural labels that merely contain the secret as a substring
   * (e.g. vault "male" must not rewrite the label "Female").
   */
  _scrubVaultToken(out, secret, replacement) {
    if (!secret || typeof secret !== 'string' || secret.length < 4) return out;
    const variants = [secret];
    const clean = secret.replace(/[\s-]/g, '');
    if (clean.length >= 6 && clean !== secret) variants.push(clean);
    for (const v of variants) {
      if (!out.includes(v)) continue;
      try {
        out = out.replace(new RegExp(`(?<!\\w)${this._escapeRegExp(v)}(?!\\w)`, 'g'), replacement);
      } catch {
        // Lookbehind unsupported (very old engines): bounded match fallback.
        try {
          out = out.replace(new RegExp(`(^|\\W)${this._escapeRegExp(v)}($|\\W)`, 'g'), (m, p1, p2) => `${p1}${replacement}${p2}`);
        } catch { /* keep original text on regex failure */ }
      }
    }
    return out;
  }

  /**
   * Scrubs page-authored decorative text (input placeholders) that contains
   * PII-shaped example values (e.g. placeholder="ABCDE1234F").
   * Placeholders are structural hints, not user data, but literal example
   * secrets must still never reach remote models — and the server VLM
   * rejects any payload containing unmasked PAN/Aadhaar patterns.
   * Classification always runs on the RAW text first, so field identity is kept.
   * NOTE: vault-secret scrubbing here is whole-token only so labels such
   * as "Female" are never rewritten because of a "male" substring.
   */
  scrubPlaceholderText(text) {
    if (!text || typeof text !== 'string') return text;
    let out = text;
    for (const secret of this._vaultSecrets()) {
      out = this._scrubVaultToken(out, secret, '[example]');
    }
    // PII-shaped examples independent of vault contents
    // L13: PAN regex is case-insensitive
    out = out.replace(/\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/gi, '[example]');
    out = out.replace(/\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[example]');
    out = out.replace(/(?<!\d)(?:(?:\+|0{0,2})91[\s-]?)?[6-9]\d{9}(?!\d)/g, '[example]');
    out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[example]');
    return out;
  }

  /**
   * Sanitizes a user prompt by replacing any raw secrets or PII with their
   * symbolic source tokens (e.g. [LOCAL_PAN]) before it is sent to the reasoning model.
   */
  sanitizeUserPrompt(text) {
    if (!text || typeof text !== 'string') return text;
    let out = text;
    
    // 1. Vault secrets (whole-token only — see _scrubVaultToken: page text
    // like "Female" must not be corrupted by a "male" substring).
    try {
      const store = this.vault || defaultLocalVault;
      for (const [key, value] of Object.entries(store.getAllSecretsForUI())) {
        out = this._scrubVaultToken(out, value, `[${key}]`);
      }
    } catch {
      // ignore vault errors
    }

    // 2. Generic PII Regex Fallbacks
    // L13: PAN regex is now case-insensitive
    out = out.replace(/\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/gi, `[${SymbolicSecretSource.LOCAL_PAN}]`);
    out = out.replace(/\b[2-9]\d{3}[\s-_]?\d{4}[\s-_]?\d{4}\b/g, `[${SymbolicSecretSource.LOCAL_AADHAAR}]`);

    // L10: Scrub email addresses from text sent to models
    out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, `[${SymbolicSecretSource.LOCAL_EMAIL}]`);

    // Scrub IFSC codes (bank branch identifiers) so the outbound policy
    // engine never blocks benign banking pages.
    out = out.replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, `[${SymbolicSecretSource.LOCAL_PROFILE}]`);

    // Common textual credential/identifier formats beyond the field-level
    // detector. These are pattern coverage, not a claim to detect arbitrary
    // private language or every national identifier.
    out = out.replace(/\b(?:0[1-9]|[12][0-9]|3[01])[-/.](?:0[1-9]|1[012])[-/.](?:19|20)\d{2}\b/g, '[REDACTED_DOB]');
    out = out.replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/gi, '[REDACTED_API_KEY]');
    out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, 'Bearer [REDACTED_TOKEN]');
    out = out.replace(/\b(?:account|acct|bank\s*account)(?:\s*(?:number|no\.?|#))?\s*[:#-]?\s*[A-Z0-9 -]{6,24}\b/gi, '[REDACTED_ACCOUNT]');

    // Scrub Indian phone numbers only when they look like standalone phone
    // numbers (not timestamps/order IDs). Require a word boundary on both
    // sides via lookarounds so substrings of longer digit runs are kept.
    out = out.replace(/(?<!\d)(?:(?:\+|0{0,2})91[\s-]?)?[6-9]\d{9}(?!\d)/g, `[${SymbolicSecretSource.LOCAL_PHONE}]`);

    // Scrub credit/debit card patterns only when Luhn-valid, otherwise
    // order IDs and timestamps would be destroyed.
    out = out.replace(/(?<!\d)(?:\d[\s-]?){13,19}(?!\d)/g, (match) => {
      const clean = match.replace(/[\s-]/g, '');
      if (/^\d{13,19}$/.test(clean)) {
        try {
          if (typeof validateLuhn === 'function' && !validateLuhn(clean)) return match;
        } catch { return match; }
        return `[${SymbolicSecretSource.LOCAL_CREDIT_CARD}]`;
      }
      return match;
    });

    return out;
  }

  /**
   * Sanitizes an array of raw DOM elements extracted from the content script.
   * @param {Array<Object>} rawElements
   * @returns {{ sanitizedElements: Array<Object>, sensitiveCount: number, detectedCategories: Set<string> }}
   */
  sanitizeElements(rawElements) {
    let sensitiveCount = 0;
    const detectedCategories = new Set();

    const sanitizedElements = rawElements.map((el) => {
      const sanitized = { ...el };

      // 1. Check structural/attribute sensitivity
      const secretCheck = this.secretDetector.classifyElement({
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || '',
        label: el.label || '',
        ariaLabel: el.ariaLabel || '',
        autocomplete: el.autocomplete || ''
      });

      // 2. Check value-based PII if value exists
      let piiCheck = null;
      if (el.value && typeof el.value === 'string' && el.value.trim() !== '') {
        piiCheck = this.piiDetector.detectPIIInText(el.value, `${el.label || ''} ${el.name || ''}`);
      }

      // 3. Mark sensitivity and redact if either check triggered
      if (secretCheck.isSensitive || piiCheck) {
        sanitized.sensitive = true;
        sanitized.value = '[REDACTED]';
        sanitized.semantic_type = secretCheck.category || piiCheck?.category || 'SENSITIVE';
        sanitized.value_source = secretCheck.source || piiCheck?.source || SymbolicSecretSource.LOCAL_PROFILE;
        
        sensitiveCount++;
        detectedCategories.add(sanitized.semantic_type);
      } else {
        sanitized.sensitive = false;
        // Preserve legitimate long non-PII values (search queries, product
        // names). Blanket redaction of inputs longer than 20 chars destroyed
        // the task context the reasoner needs. PII in values is still caught
        // by detectPIIInText above and by the outbound policy engine.
      }

      // 4. Scrub PII-shaped example text from placeholders (page-authored hints,
      // not user data) so literal examples never reach remote models.
      sanitized.placeholder = this.scrubPlaceholderText(sanitized.placeholder);
      if (sanitized.label) sanitized.label = this.scrubPlaceholderText(sanitized.label);
      if (sanitized.context) sanitized.context = this.sanitizeUserPrompt(sanitized.context);
      if (Array.isArray(sanitized.options)) {
        sanitized.options = sanitized.options.map((o) => this.sanitizeUserPrompt(o));
      }

      // 5. Clean up any internal raw references
      delete sanitized.rawElement;
      return sanitized;
    });

    return {
      sanitizedElements,
      sensitiveCount,
      detectedCategories: Array.from(detectedCategories)
    };
  }

  sanitizeResultItems(items = []) {
    return (items || []).map((it) => ({
      ...it,
      title: this.sanitizeUserPrompt(it.title || ''),
      text: this.sanitizeUserPrompt(String(it.text || '').slice(0, 360)),
      price_text: this.sanitizeUserPrompt(it.price_text || '') || null,
      price_value: it.price_value ?? null
    }));
  }

  sanitizePageExtras(rawDOM = {}) {
    return {
      headings: (rawDOM.headings || []).map((h) => ({
        ...h,
        text: this.sanitizeUserPrompt(h.text || '')
      })),
      visible_text: this.sanitizeUserPrompt(String(rawDOM.visible_text || '')).slice(0, 4000),
      result_items: this.sanitizeResultItems(rawDOM.result_items || []),
      scroll: rawDOM.scroll || null
    };
  }

  /**
   * Returns true when known sensitive text has no reliable on-screen box.
   * In that case callers must omit the original screenshot entirely.
   */
  hasUnlocatedSensitiveText(rawDOM = {}) {
    const patterns = [
      /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/i,
      /\b[A-Z]{5}\d{4}[A-Z]\b/i,
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
      /(?<!\d)(?:(?:\+|0{0,2})91[\s-]?)?[6-9]\d{9}(?!\d)/,
      /\b(?:0[1-9]|[12]\d|3[01])[-/.](?:0[1-9]|1[0-2])[-/.](?:19|20)\d{2}\b/,
      /\b(?:password|passcode|one.time.code|otp|account number|bank account|api key|access token)\s*[:#-]\s*\S+/i
    ];
    const texts = [rawDOM.visible_text, ...(rawDOM.headings || []).map((h) => h.text), ...(rawDOM.result_items || []).map((i) => i.text || i.title)];
    // These text aggregates do not carry reliable pixel boxes. Even if some
    // originating nodes had geometry, the screenshot redactor only receives
    // interactive-element boxes, so any recognized match requires withholding
    // the full image.
    return texts.some((value) => typeof value === 'string' && patterns.some((pattern) => pattern.test(value)));
  }

  /**
   * Cleans a URL to keep only domain/origin and non-sensitive path
   * L9: Expanded sensitive URL parameter list
   */
  sanitizeUrl(url) {
    try {
      const parsed = new URL(url);
      // L9: Comprehensive sensitive query parameter list
      const sensitiveParams = [
        'token', 'auth', 'code', 'key', 'password', 'pass', 'session',
        'id_token', 'access_token', 'refresh_token',
        // L9: Additional sensitive parameters
        'api_key', 'apikey', 'api-key',
        'secret', 'client_secret',
        'jwt', 'bearer',
        'state', 'nonce',
        'sid', 'session_id', 'sessionid',
        'csrf', 'csrf_token', '_csrf',
        'otp', 'verification_code',
        'private_key', 'privatekey',
        'ssn', 'aadhaar', 'pan',
        'credit_card', 'card_number',
        'user_token', 'auth_token', 'authorization'
      ];
      for (const param of sensitiveParams) {
        if (parsed.searchParams.has(param)) {
          parsed.searchParams.set(param, '[REDACTED]');
        }
      }
      // Also redact any param whose name contains sensitive keywords
      for (const [pKey] of parsed.searchParams.entries()) {
        const pLower = pKey.toLowerCase();
        if (/token|secret|key|pass|auth|session|jwt|cred|private/i.test(pLower)) {
          parsed.searchParams.set(pKey, '[REDACTED]');
        }
      }
      return parsed.toString();
    } catch {
      return 'https://[REDACTED_OR_LOCAL]';
    }
  }
}

export const defaultDOMSanitizer = new DOMSanitizer();
