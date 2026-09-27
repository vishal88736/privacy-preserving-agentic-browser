/**
 * Outbound Privacy Policy Engine
 * Scans all outgoing network payloads before dispatch to ensure
 * no plaintext secrets, PII, or vault credentials bypass sanitization.
 *
 * Uses the shared local PII registry plus exact configured vault values.
 */

import { defaultLocalVault } from './local-vault.js';
import { defaultPIIDetector } from './pii-detector.js';
import { findPIIMatches } from './pii-rules.js';
import { SymbolicSecretSource } from '../shared/constants.js';

export class OutboundPolicyViolationError extends Error {
  constructor(message, violationDetails = null) {
    super(message);
    this.name = 'OutboundPolicyViolationError';
    this.violationDetails = violationDetails;
  }
}

export class PolicyEngine {
  constructor(vault = defaultLocalVault, piiDetector = defaultPIIDetector) {
    this.vault = vault;
    this.piiDetector = piiDetector;
  }

  /**
   * Deeply scans an outbound object/payload for leaked plaintext values.
   * Throws OutboundPolicyViolationError if any raw secret is discovered.
   */
  enforceOutboundSafety(payload) {
    const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
    // Strip machine-generated numeric metadata that is never PII so the
    // phone/card patterns cannot false-positive on it (e.g. Date.now()
    // timestamps are 13 digits and contain 10-digit substrings starting 6-9).
    // Also strip embedded base64 image bytes (screenshots): pattern-matching
    // PAN/phone/card shapes inside base64 is meaningless — the bytes are an
    // encoding, not text — and randomly matches (e.g. "QaYvq1115D" tripping
    // the PAN pattern), killing benign tasks. Screenshot secrecy is enforced
    // by the fail-closed canvas redaction before this point, and every DOM /
    // text / metadata field below remains fully scanned.
    const scannable = serialized
      .replace(/"timestamp"\s*:\s*\d+/g, '"timestamp":0')
      .replace(/"timestamp"\s*:\s*"\d+"/g, '"timestamp":"0"')
      .replace(/data:[a-z]+\/[^"\\]*;base64,[A-Za-z0-9+/=]+/gi, 'data:image/omitted');

    const textLeaves = [];
    const collectText = (value) => {
      if (typeof value === 'string') {
        // Encoded screenshot bytes are opaque to text patterns. Screenshot
        // coverage is enforced locally by OCR, redaction, and fail-closed
        // withholding before the payload reaches this policy check.
        if (!/^data:image\/[^;]+;base64,/i.test(value)) textLeaves.push(value);
      }
      else if (Array.isArray(value)) value.forEach(collectText);
      else if (value && typeof value === 'object') Object.values(value).forEach(collectText);
    };
    collectText(typeof payload === 'string' ? scannable : payload);
    const normalizeSecretText = (value) => String(value).normalize('NFKC')
      .replace(/[\p{Cf}]/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 1. Scan against all plaintext secrets currently held in the local vault
    // L11: getAllSecretsForUI now returns only string values, so no blob bloat
    const nonSecretTokens = new Set([
      SymbolicSecretSource.LOCAL_COUNTRY,
      SymbolicSecretSource.LOCAL_GENDER,
      SymbolicSecretSource.LOCAL_TERMS
    ]);
    const secrets = this.vault.getAllSecretsForUI();
    for (const [key, value] of Object.entries(secrets)) {
      if (nonSecretTokens.has(key)) continue;
      const minLength = key === SymbolicSecretSource.LOCAL_CVV ? 3 : 4;
      if (typeof value === 'string' && value.replace(/[\s-]/g, '').length >= minLength) {
        const canonicalSecret = normalizeSecretText(value);
        const compactSecret = canonicalSecret.replace(/[\s-]/g, '');
        const flexiblePattern = escapePattern(canonicalSecret).replace(/ /g, '\\s+');
        let secretRegex = null;
        try { secretRegex = new RegExp(`(?<![\\p{L}\\p{N}])${flexiblePattern}(?![\\p{L}\\p{N}])`, 'iu'); } catch {}
        const found = textLeaves.some((leaf) => secretRegex?.test(normalizeSecretText(leaf)) ||
          (canonicalSecret !== compactSecret && compactSecret.length >= minLength &&
            normalizeSecretText(leaf).replace(/[\s-]/g, '').includes(compactSecret)));
        if (found) {
          throw new OutboundPolicyViolationError(
            `Outbound policy blocked payload: Contains raw value of ${key}`,
            { key }
          );
        }
      }
    }

    // Use the same registry as the local DOM sanitizer for identifiers,
    // payment data, and date formats. Context hint is empty so context-gated
    // rules (SSN_COMPACT, SIN, NHS, DOB, IFSC, PHONE_IN) only fire when
    // their trigger word appears near the actual match in the text, not when
    // it appears anywhere in the full serialized payload.
    const piiMatch = findPIIMatches(scannable, '')[0];
    if (piiMatch) {
      // Title-case display label: the UI parses this message, and tests
      // assert /Aadhaar/ (not the uppercase category constant).
      const labels = {
        AADHAAR: 'Aadhaar', PAN: 'PAN', SSN: 'SSN', SIN: 'SIN', NIN: 'NIN',
        NHS: 'NHS', IBAN: 'IBAN', CREDIT_CARD: 'payment card',
        EMAIL: 'email address', PHONE: 'phone number', DOB: 'date of birth',
        IFSC: 'IFSC code', PASSWORD: 'password'
      };
      const label = labels[piiMatch.category] || String(piiMatch.category || 'sensitive').toLowerCase();
      throw new OutboundPolicyViolationError(
        `Outbound policy blocked payload: Unredacted ${label} pattern found in request body`,
        { category: piiMatch.category }
      );
    }
    const apiKeyMatch = scannable.match(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/i);
    if (apiKeyMatch) {
      throw new OutboundPolicyViolationError('Outbound policy blocked payload: API-key-like token found.', { category: 'API_KEY' });
    }
    const bearerMatch = scannable.match(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/i);
    if (bearerMatch) {
      throw new OutboundPolicyViolationError('Outbound policy blocked payload: Bearer token found.', { category: 'TOKEN' });
    }

    return true;
  }
}

export const defaultPolicyEngine = new PolicyEngine();
