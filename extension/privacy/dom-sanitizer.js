/**
 * Local DOM Sanitizer
 * Strips sensitive values, masks PII, and assigns symbolic source tokens
 * before the DOM representation can be sent to remote models.
 */

import { defaultPIIDetector } from './pii-detector.js';
import { defaultSecretDetector } from './secret-detector.js';
import { SymbolicSecretSource } from '../shared/constants.js';

export class DOMSanitizer {
  constructor(piiDetector = defaultPIIDetector, secretDetector = defaultSecretDetector) {
    this.piiDetector = piiDetector;
    this.secretDetector = secretDetector;
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

      // 4. Clean up any internal raw references
      delete sanitized.rawElement;
      return sanitized;
    });

    return {
      sanitizedElements,
      sensitiveCount,
      detectedCategories: Array.from(detectedCategories)
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
