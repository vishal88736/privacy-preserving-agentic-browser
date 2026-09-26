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
      if (typeof value === 'string' && value.length >= 4) {
        // Check raw inclusion
        if (scannable.includes(value)) {
          throw new OutboundPolicyViolationError(
            `Outbound policy blocked payload: Contains raw value of ${key}`,
            { key }
          );
        }
        // Also check clean alphanumeric format (e.g. without spaces for Aadhaar)
        const cleanVal = value.replace(/[\s-]/g, '');
        if (cleanVal.length >= 6 && scannable.includes(cleanVal)) {
          throw new OutboundPolicyViolationError(
            `Outbound policy blocked payload: Contains stripped value of ${key}`,
            { key }
          );
        }
      }
    }

    // Use the same registry as the local DOM sanitizer for identifiers,
    // payment data, and date formats. Bare Indian mobile numbers and IFSC
    // codes are unconditional registry rules (no context gating), so they
    // are blocked even when the payload omits a trigger word.
    const piiMatch = findPIIMatches(scannable, scannable)[0];
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
