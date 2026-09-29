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

const BENIGN_REFERENCE_CONTEXT = /\b(?:order|tracking|shipment|reference|invoice|booking|confirmation|reservation|ticket|case|record|product|serial|transaction|delivery|application)\b/i;
const AADHAAR_CONTEXT = /\b(?:aadhaar|aadhar|uidai|unique\s+identity)\b/i;

function redactPagePII(text) {
  const matches = findPIIMatches(text, '');
  if (!matches.length) return text;
  let result = '';
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue;
    const nearby = text.slice(Math.max(0, match.index - 60), Math.min(text.length, match.end + 60));
    // Long order/tracking identifiers share the Aadhaar shape. Preserve that
    // number only when the page explicitly labels it as a non-identity
    // reference and contains no Aadhaar-specific cue in the same neighborhood.
    const benignReference = match.category === 'AADHAAR' &&
      BENIGN_REFERENCE_CONTEXT.test(nearby) && !AADHAAR_CONTEXT.test(nearby);
    result += text.slice(cursor, match.index) + (benignReference ? match.value : `[REDACTED_${match.category}]`);
    cursor = match.end;
  }
  return result + text.slice(cursor);
}

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

  _vaultMinimumLength(key) {
    return key === SymbolicSecretSource.LOCAL_CVV || key === SymbolicSecretSource.LOCAL_PASSWORD ? 3 : 4;
  }

  /** Case-insensitive whole-token matching tolerates whitespace and zero-width obfuscation. */
  _scrubVaultToken(out, secret, replacement, minimumLength = 4) {
    if (!secret || typeof secret !== 'string') return out;
    const canonical = secret.normalize('NFKC').replace(/[\p{Cf}]/gu, '').trim();
    const compact = canonical.replace(/[\s-]/g, '');
    if (compact.length < minimumLength) return out;
    const variants = [...new Set([canonical, compact])];
    for (const variant of variants) {
      if (!variant) continue;
      const chunks = variant.split(/[\s-]+/).filter(Boolean);
      if (!chunks.length) continue;
      const chunkPattern = (chunk) => [...chunk].map((char) =>
        `${this._escapeRegExp(char)}[\\p{Cf}]*`
      ).join('');
      const pattern = chunks.map(chunkPattern).join('[\\s-]+');
      try {
        const wholeToken = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'giu');
        out = out.replace(wholeToken, replacement);
      } catch {
        // Keep privacy failure closed on older runtimes without Unicode property support.
        try {
          const fallback = new RegExp(`(^|\\W)${this._escapeRegExp(variant)}($|\\W)`, 'gi');
          out = out.replace(fallback, (match, prefix, suffix) => `${prefix}${replacement}${suffix}`);
        } catch { /* retain input if the regular expression cannot be built */ }
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
    try {
      const store = this.vault || defaultLocalVault;
      for (const [key, secret] of Object.entries(store.getAllSecretsForUI())) {
        out = this._scrubVaultToken(out, secret, '[example]', this._vaultMinimumLength(key));
      }
    } catch { /* keep page-authored hint if the vault is unavailable */ }
    return redactPII(out, fieldContext).replace(/\[REDACTED_[A-Z_]+\]/g, '[example]');
  }

  /**
   * Sanitizes a user prompt by replacing any raw secrets or PII with their
   * symbolic source tokens (e.g. [LOCAL_PAN]) before it is sent to the reasoning model.
   */
  sanitizeUserPrompt(text) {
    if (!text || typeof text !== 'string') return text;
    // Canonicalize compatibility forms and discard invisible format
    // characters before matching any identifiers or credentials.
    let out = text.normalize('NFKC').replace(/[\p{Cf}]/gu, '');
    
    // 1. Vault secrets (whole-token only — see _scrubVaultToken: page text
    // like "Female" must not be corrupted by a "male" substring).
    try {
      const store = this.vault || defaultLocalVault;
      for (const [key, value] of Object.entries(store.getAllSecretsForUI())) {
        out = this._scrubVaultToken(out, value, `[${key}]`, this._vaultMinimumLength(key));
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

  /** Canonical page fields use an explicit redaction marker, never a sample value. */
  sanitizeCanonicalText(text) {
    return String(this.sanitizeUserPrompt(String(text || '')) || '').replace(/\[example\]/gi, '[REDACTED]');
  }

  /**
   * Sanitizer for page-authored text. It applies the shared PII registry but
   * preserves long numbers explicitly identified as ordinary order/reference
   * IDs. Ambiguous dates and phone-like numbers still use context gating.
   */
  sanitizePageText(text) {
    if (!text || typeof text !== 'string') return text;
    let out = text.normalize('NFKC').replace(/[\p{Cf}]/gu, '');
    try {
      const store = this.vault || defaultLocalVault;
      for (const [key, value] of Object.entries(store.getAllSecretsForUI())) {
        out = this._scrubVaultToken(out, value, `[${key}]`, this._vaultMinimumLength(key));
      }
    } catch { /* ignore vault errors */ }
    out = out.replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/gi, '[REDACTED_API_KEY]');
    out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, 'Bearer [REDACTED_TOKEN]');
    out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_TOKEN]');
    out = out.replace(/\b(?:reset|invite|token|auth|session|verify|verification|credential|secret|key|code)[-_]?[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_TOKEN]');
    return redactPagePII(out);
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
        if (typeof el.value === 'string' && el.value) {
          const normalizedValue = el.value.normalize('NFKC').replace(/[\p{Cf}]/gu, '');
          const scrubbedValue = this.sanitizeUserPrompt(el.value);
          sanitized.value = scrubbedValue;
          if (scrubbedValue !== normalizedValue) {
            sanitized.sensitive = true;
            const source = scrubbedValue.match(/\[(LOCAL_[A-Z0-9_]+)\]/)?.[1];
            sanitized.value_source = source || SymbolicSecretSource.LOCAL_PROFILE;
            sanitized.semantic_type = source?.replace(/^LOCAL_/, '') || 'CREDENTIAL';
            sensitiveCount++;
            detectedCategories.add(sanitized.semantic_type);
          }
        }
      }

      // 4. Scrub PII-shaped example text from placeholders (page-authored hints,
      // not user data) so literal examples never reach remote models. The
      // field's label+name is the context hint for gated rules (phone, DOB).
      const fieldContext = `${sanitized.label || ''} ${sanitized.name || ''}`.trim();
      sanitized.placeholder = this.scrubPlaceholderText(sanitized.placeholder, fieldContext);
      if (sanitized.label) sanitized.label = this.scrubPlaceholderText(sanitized.label, sanitized.name || '');
      if (sanitized.ariaLabel) sanitized.ariaLabel = this.sanitizeUserPrompt(sanitized.ariaLabel);
      sanitized.accessible_name = this.sanitizeCanonicalText(
        sanitized.label || sanitized.ariaLabel || sanitized.accessible_name || ''
      );
      sanitized.text = this.sanitizeCanonicalText(sanitized.text).slice(0, 180);
      sanitized.title = this.sanitizeCanonicalText(sanitized.title).slice(0, 180);
      if (sanitized.ariaDescribedBy) sanitized.ariaDescribedBy = this.sanitizeCanonicalText(sanitized.ariaDescribedBy);
      if (sanitized.fieldset_legend) sanitized.fieldset_legend = this.sanitizeCanonicalText(sanitized.fieldset_legend);
      if (sanitized.context) sanitized.context = this.sanitizeCanonicalText(sanitized.context);
      if (sanitized.href) sanitized.href = this.sanitizeLink(sanitized.href);
      if (Array.isArray(sanitized.options)) {
        // Options are {text, value, selected} objects. Page-authored example
        // text is scrubbed like placeholders (with the field's label+name as
        // the context hint for gated rules). PII-shaped option VALUES are
        // redacted and flagged so the executor matches the live option by
        // its text instead.
        sanitized.options = sanitized.options.map((o) => {
          if (typeof o === 'string') return this.sanitizeUserPrompt(this.scrubPlaceholderText(o, fieldContext));
          if (o && typeof o === 'object') {
            const clean = { ...o };
            if (typeof clean.text === 'string') clean.text = this.sanitizeCanonicalText(this.scrubPlaceholderText(clean.text, fieldContext));
            if (typeof clean.label === 'string') clean.label = this.sanitizeCanonicalText(this.scrubPlaceholderText(clean.label, fieldContext));
            if (typeof clean.value === 'string' && clean.value.trim() &&
                (findPIIMatches(clean.value, fieldContext).length || this.sanitizeUserPrompt(clean.value) !== clean.value)) {
              clean.value = '[REDACTED]';
              clean.value_redacted = true;
            }
            return clean;
          }
          return o;
        });
      }
      if (sanitized.selected_option && typeof sanitized.selected_option === 'object') {
        const selected = Array.isArray(sanitized.options)
          ? sanitized.options.find((option) => option && typeof option === 'object' && option.selected)
          : null;
        sanitized.selected_option = selected
          ? { index: sanitized.selected_option.index, text: selected.text || '', value: selected.value || '' }
          : {
              index: sanitized.selected_option.index,
              text: this.sanitizeCanonicalText(sanitized.selected_option.text),
              value: this.sanitizeCanonicalText(sanitized.selected_option.value)
            };
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
      // Free page prose and structural snippets share the same precise policy:
      // known PII is masked, while recognizable order references and ordinary
      // dates remain available as semantic context.
      visible_text: this.sanitizePageText(String(rawDOM.visible_text || '')).slice(0, 4000),
      result_items: this.sanitizeResultItems(rawDOM.result_items || []),
      scroll: rawDOM.scroll || null,
      // Strict local-only schema for ActionVerifier. PromptBuilder's outbound
      // allowlist intentionally does not serialize this field.
      local_media_state: this.sanitizeLocalMediaState(rawDOM.local_media_state)
    };
  }

  sanitizeLocalMediaState(state) {
    const media = Array.isArray(state?.media) ? state.media.slice(0, 20) : [];
    const cleanMedia = media.flatMap((item, index) => {
      const tag = item?.tag === 'audio' ? 'audio' : item?.tag === 'video' ? 'video' : null;
      if (!tag) return [];
      return [{
        ordinal: index,
        tag,
        paused: item?.paused !== false,
        ended: Boolean(item?.ended),
        ready_state: Number.isInteger(item?.ready_state)
          ? Math.max(0, Math.min(4, item.ready_state))
          : 0
      }];
    });
    return { visible_count: cleanMedia.length, media: cleanMedia };
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
      ['CREDENTIAL', /\b(?:cvv|cvc|card verification)\s*(?::|=|\bis\s+)?\d{3,4}\b/gi],
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
      for (const match of findPIIMatches(value, '')) addSpan(match.category, match.index, match.end);
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
      if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(segment) ||
          /(?:reset|invite|token|auth|session|verify|verification|credential|secret|key|code)[-_]?[A-Za-z0-9_-]{12,}/i.test(segment) ||
          /^(?=[A-Za-z0-9_-]{24,}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]+$/.test(segment)) {
        return '[REDACTED_TOKEN]';
      }
      return this.sanitizePageText(segment);
    }).join('/');
  }

  /** Keep link destination context without sending query values or fragments. */
  sanitizeLink(href) {
    if (typeof href !== 'string' || !href.trim()) return '';
    try {
      const absolute = /^[a-z][a-z\d+.-]*:/i.test(href);
      const parsed = new URL(href, 'https://local.invalid');
      const path = this._sanitizePathSegments(decodeURIComponent(parsed.pathname));
      return absolute ? `${parsed.origin}${path}` : path;
    } catch {
      return '[LINK]';
    }
  }
}

export const defaultDOMSanitizer = new DOMSanitizer();
