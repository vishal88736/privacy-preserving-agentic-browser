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
  /**
   * Scrubs page-authored decorative text (input placeholders) that contains
   * PII-shaped example values (e.g. placeholder="ABCDE1234F").
   * `fieldContext` is the field's label+name: context-gated rules (phone,
   * DOB, IBAN) use it to decide whether an example value is sensitive.
   * Classification always runs on the RAW text first, so field identity is
   * kept. Vault-secret scrubbing here is whole-token only so labels such
   * as "Female" are never rewritten because of a "male" substring.
   */
  scrubPlaceholderText(text, fieldContext = '') {
    if (!text || typeof text !== 'string') return text;
    let out = text;
    for (const secret of this._vaultSecrets()) {
      out = this._scrubVaultToken(out, secret, '[example]');
    }
    return redactPII(out, fieldContext).replace(/\[REDACTED_[A-Z_]+\]/g, '[example]');
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
   * Lighter sanitizer for page-authored text (headings, result titles,
   * visible text). Only scrubs exact vault secrets and credential-shaped
   * patterns (API keys, Bearer tokens). Does NOT run the full PII regex
   * registry because that over-redacts order IDs, dates, and phone-like
   * numbers in product listings — destroying the context the reasoner needs.
   */
  sanitizePageText(text) {
    if (!text || typeof text !== 'string') return text;
    let out = text;
    try {
      const store = this.vault || defaultLocalVault;
      for (const [key, value] of Object.entries(store.getAllSecretsForUI())) {
        out = this._scrubVaultToken(out, value, `[${key}]`);
      }
    } catch { /* ignore vault errors */ }
    out = out.replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/gi, '[REDACTED_API_KEY]');
    out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, 'Bearer [REDACTED_TOKEN]');
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
      // not user data) so literal examples never reach remote models. The
      // field's label+name is the context hint for gated rules (phone, DOB).
      const fieldContext = `${sanitized.label || ''} ${sanitized.name || ''}`.trim();
      sanitized.placeholder = this.scrubPlaceholderText(sanitized.placeholder, fieldContext);
      if (sanitized.label) sanitized.label = this.scrubPlaceholderText(sanitized.label, sanitized.name || '');
      if (sanitized.ariaLabel) sanitized.ariaLabel = this.sanitizeUserPrompt(sanitized.ariaLabel);
      if (sanitized.ariaDescribedBy) sanitized.ariaDescribedBy = this.sanitizeUserPrompt(sanitized.ariaDescribedBy);
      if (sanitized.fieldset_legend) sanitized.fieldset_legend = this.sanitizeUserPrompt(sanitized.fieldset_legend);
      if (sanitized.context) sanitized.context = this.sanitizeUserPrompt(sanitized.context);
      if (sanitized.href) sanitized.href = this.sanitizeLink(sanitized.href);
      if (Array.isArray(sanitized.options)) {
        // Options are {text, value, selected} objects. Page-authored example
        // text is scrubbed like placeholders (with the field's label+name as
        // the context hint for gated rules). PII-shaped option VALUES are
        // redacted and flagged so the executor matches the live option by
        // its text instead.
        sanitized.options = sanitized.options.map((o) => {
          if (typeof o === 'string') return this.scrubPlaceholderText(o, fieldContext);
          if (o && typeof o === 'object') {
            const clean = { ...o };
            if (typeof clean.text === 'string') clean.text = this.scrubPlaceholderText(clean.text, fieldContext);
            if (typeof clean.label === 'string') clean.label = this.scrubPlaceholderText(clean.label, fieldContext);
            if (typeof clean.value === 'string' && clean.value.trim() &&
                findPIIMatches(clean.value, fieldContext).length) {
              clean.value = '[REDACTED]';
              clean.value_redacted = true;
            }
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
      title: this.sanitizePageText(it.title || ''),
      text: this.sanitizePageText(String(it.text || '').slice(0, 360)),
      price_text: this.sanitizePageText(it.price_text || '') || null,
      price_value: it.price_value ?? null
    }));
  }

  sanitizePageExtras(rawDOM = {}) {
    return {
      headings: (rawDOM.headings || []).map((h) => ({
        ...h,
        text: this.sanitizePageText(h.text || '')
      })),
      // visible_text keeps the full PII registry scan (with proximity-gated
      // context rules): page prose is a primary PII leak vector. Structural
      // headings/result titles use the lighter sanitizePageText so the
      // reasoner keeps its grounding context.
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
      parsed.pathname = this._sanitizePathSegments(decodeURIComponent(parsed.pathname));
      return parsed.toString();
    } catch {
      return 'https://[REDACTED_OR_LOCAL]';
    }
  }

  /**
   * Targeted PII scan of individual path segments. A segment that matches a
   * PII pattern is replaced wholesale with a generic [REDACTED_PII] label —
   * category labels inside a URL path are noise, and partial redaction would
   * leave reconstructable fragments. Non-PII segments still get vault and
   * credential scrubbing via sanitizePageText.
   */
  _sanitizePathSegments(pathname) {
    return String(pathname || '').split('/').map((segment) => {
      if (!segment) return segment;
      if (findPIIMatches(segment).length) return '[REDACTED_PII]';
      return this.sanitizePageText(segment);
    }).join('/');
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
