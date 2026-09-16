/**
 * Local DOM Sanitizer
 * Strips sensitive values, masks PII, and assigns symbolic source tokens
 * before the DOM representation can be sent to remote models.
 */

import { defaultPIIDetector } from './pii-detector.js';
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

  /**
   * Scrubs page-authored decorative text (input placeholders) that contains
   * PII-shaped example values (e.g. placeholder="ABCDE1234F").
   * Placeholders are structural hints, not user data, but literal example
   * secrets must still never reach remote models — and the server VLM
   * rejects any payload containing unmasked PAN/Aadhaar patterns.
   * Classification always runs on the RAW text first, so field identity is kept.
   */
  scrubPlaceholderText(text) {
    if (!text || typeof text !== 'string') return text;
    let out = text;
    for (const secret of this._vaultSecrets()) {
      if (secret.length >= 4 && out.includes(secret)) {
        out = out.split(secret).join('[example]');
      }
      const clean = secret.replace(/[\s-]/g, '');
      if (clean.length >= 6 && clean !== secret && out.includes(clean)) {
        out = out.split(clean).join('[example]');
      }
    }
    // PII-shaped examples independent of vault contents
    out = out.replace(/\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g, '[example]');
    out = out.replace(/\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[example]');
    return out;
  }

  /**
   * Sanitizes a user prompt by replacing any raw secrets or PII with their
   * symbolic source tokens (e.g. [LOCAL_PAN]) before it is sent to the reasoning model.
   */
  sanitizeUserPrompt(text) {
    if (!text || typeof text !== 'string') return text;
    let out = text;
    
    // 1. Vault secrets
    try {
      const store = this.vault || defaultLocalVault;
      for (const [key, value] of Object.entries(store.getAllSecretsForUI())) {
        if (typeof value === 'string' && value.length >= 4) {
          if (out.includes(value)) {
            out = out.split(value).join(`[${key}]`);
          }
          const clean = value.replace(/[\s-]/g, '');
          if (clean.length >= 6 && clean !== value && out.includes(clean)) {
            out = out.split(clean).join(`[${key}]`);
          }
        }
      }
    } catch {
      // ignore vault errors
    }

    // 2. Generic PII Regex Fallbacks
    out = out.replace(/\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g, `[${SymbolicSecretSource.LOCAL_PAN}]`);
    out = out.replace(/\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g, `[${SymbolicSecretSource.LOCAL_AADHAAR}]`);
    
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
        // Also scrub any unexpected values from generic inputs to avoid accidental leakage
        if (el.tag === 'input' && ['text', 'search', 'email', 'tel', 'number'].includes(el.type || '')) {
          // If value is present but wasn't flagged as strict PII, check if it looks like a long string or potential leak
          if (el.value && el.value.length > 20) {
            sanitized.value = '[NON_SENSITIVE_TEXT]';
          }
        }
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
      price_text: it.price_text || null,
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
   * Cleans a URL to keep only domain/origin and non-sensitive path
   */
  sanitizeUrl(url) {
    try {
      const parsed = new URL(url);
      // Remove sensitive query parameters (token, auth, code, key, pass, session)
      const sensitiveParams = ['token', 'auth', 'code', 'key', 'password', 'pass', 'session', 'id_token', 'access_token'];
      for (const param of sensitiveParams) {
        if (parsed.searchParams.has(param)) {
          parsed.searchParams.set(param, '[REDACTED]');
        }
      }
      return parsed.toString();
    } catch {
      return 'https://[REDACTED_OR_LOCAL]';
    }
  }
}

export const defaultDOMSanitizer = new DOMSanitizer();
