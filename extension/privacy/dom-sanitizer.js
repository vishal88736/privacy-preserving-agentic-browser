/**
 * Local DOM Sanitizer
 * Strips sensitive values, masks PII, and assigns symbolic source tokens
 * before the DOM representation can be sent to remote models.
 *
 * L9: Expanded sensitive URL parameters
 * L10: Visible text is now scanned for email, phone, and credit card patterns
 * L13: PAN regex is now case-insensitive
 */

import { defaultPIIDetector } from './pii-detector.js';
import { defaultSecretDetector } from './secret-detector.js';
import { defaultLocalVault } from './local-vault.js';
import { SymbolicSecretSource } from '../shared/constants.js';
import { findPIIMatches, redactPII } from './pii-rules.js';

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
    return redactPII(out, text).replace(/\[REDACTED_[A-Z_]+\]/g, '[example]');
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

    // 2. Use the same PII registry as the outbound policy engine.
    out = redactPII(out);

    // Credential-shaped text not covered by region-specific identity rules.
    out = out.replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/gi, '[REDACTED_API_KEY]');
    out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, 'Bearer [REDACTED_TOKEN]');
    out = out.replace(/\b(?:account|acct|bank\s*account)(?:\s*(?:number|no\.?|#))?\s*[:#-]?\s*[A-Z0-9 -]{6,24}\b/gi, '[REDACTED_ACCOUNT]');

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
      if (sanitized.ariaLabel) sanitized.ariaLabel = this.sanitizeUserPrompt(sanitized.ariaLabel);
      if (sanitized.ariaDescribedBy) sanitized.ariaDescribedBy = this.sanitizeUserPrompt(sanitized.ariaDescribedBy);
      if (sanitized.fieldset_legend) sanitized.fieldset_legend = this.sanitizeUserPrompt(sanitized.fieldset_legend);
      if (sanitized.context) sanitized.context = this.sanitizeUserPrompt(sanitized.context);
      if (sanitized.href) sanitized.href = this.sanitizeLink(sanitized.href);
      if (Array.isArray(sanitized.options)) {
        // Options are {text, value, selected} objects; sanitizeUserPrompt
        // returns non-strings unchanged, so scrub each text field directly.
        // PII in option text must never reach the server. Values are kept
        // because the executor matches the live option by value.
        sanitized.options = sanitized.options.map((o) => {
          if (typeof o === 'string') return this.sanitizeUserPrompt(o);
          if (o && typeof o === 'object') {
            const clean = { ...o };
            if (typeof clean.text === 'string') clean.text = this.sanitizeUserPrompt(clean.text);
            if (typeof clean.label === 'string') clean.label = this.sanitizeUserPrompt(clean.label);
            return clean;
          }
          return o;
        });
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
    return Object.values(this.getUnlocatedSensitiveCounts(rawDOM)).some((count) => count > 0);
  }

  /** Count known sensitive text without returning any of its values. */
  getUnlocatedSensitiveCounts(rawDOM = {}) {
    const patterns = [
      ['CREDENTIAL', /\b(?:password|passcode|one[ .-]?time(?:[ .-]code|[ .-]password)?|otp|account number|bank account|api key|access token)\s*[:#-]\s*\S+/gi],
      ['CREDENTIAL', /\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/gi],
      ['CREDENTIAL', /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi],
    ];
    const aggregateTexts = typeof rawDOM.visible_text === 'string' && rawDOM.visible_text
      ? [rawDOM.visible_text]
      : [...(rawDOM.headings || []).map((h) => h.text), ...(rawDOM.result_items || []).map((i) => i.text || i.title)];
    const observed = {};
    for (const value of new Set(aggregateTexts.filter((item) => typeof item === 'string' && item))) {
      const spansByCategory = new Map();
      const addSpan = (category, start, end) => {
        if (!spansByCategory.has(category)) spansByCategory.set(category, []);
        spansByCategory.get(category).push({ start, end });
      };
      for (const match of findPIIMatches(value, value)) addSpan(match.category, match.index, match.end);
      for (const [category, pattern] of patterns) {
        pattern.lastIndex = 0;
        for (const match of value.matchAll(pattern)) addSpan(category, match.index, match.index + match[0].length);
      }
      for (const [category, spans] of spansByCategory) {
        spans.sort((a, b) => a.start - b.start || a.end - b.end);
        let count = 0;
        let end = -1;
        for (const span of spans) {
          if (span.start >= end) count++;
          end = Math.max(end, span.end);
        }
        observed[category] = (observed[category] || 0) + count;
      }
    }
    return observed;
  }

  /**
   * Cleans a URL to keep only domain/origin and non-sensitive path
   * L9: Expanded sensitive URL parameter list
   */
  sanitizeUrl(url) {
    try {
      const parsed = new URL(url);
      parsed.username = '';
      parsed.password = '';
      for (const key of new Set(parsed.searchParams.keys())) parsed.searchParams.set(key, '[REDACTED]');
      parsed.hash = '';
      parsed.pathname = this.sanitizeUserPrompt(decodeURIComponent(parsed.pathname));
      return parsed.toString();
    } catch {
      return 'https://[REDACTED_OR_LOCAL]';
    }
  }

  /** Keep link destination context without sending query values or fragments. */
  sanitizeLink(href) {
    if (typeof href !== 'string' || !href.trim()) return '';
    try {
      const absolute = /^[a-z][a-z\d+.-]*:/i.test(href);
      const parsed = new URL(href, 'https://local.invalid');
      const path = this.sanitizeUserPrompt(decodeURIComponent(parsed.pathname));
      return absolute ? `${parsed.origin}${path}` : path;
    } catch {
      return '[LINK]';
    }
  }
}

export const defaultDOMSanitizer = new DOMSanitizer();
