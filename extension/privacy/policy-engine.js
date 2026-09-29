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
    const scannable = serialized.replace(/"timestamp"\s*:\s*\d+/g, '"timestamp":0')
      .replace(/"timestamp"\s*:\s*"\d+"/g, '"timestamp":"0"');

    // Screenshots are NOT excluded from this check.
    //
    // Base64 bytes cannot be pattern-matched for PAN/card/phone shapes — they
    // are an encoding, not text, and matching them randomly trips rules like
    // "QaYvq1115D" and kills benign tasks. That part is still true, and it is
    // why pixel secrecy cannot be re-derived here.
    //
    // But the old behaviour was to *delete* the screenshot from the scanned
    // string and proceed, which made the largest and highest-risk artifact in
    // every payload the one thing with zero verification on the final local
    // gate. If upstream redaction silently failed, nothing here would notice.
    //
    // Instead every image is now required to carry an explicit redaction
    // attestation, and a payload containing an unattested image is rejected
    // outright. The claim travels with the bytes instead of being assumed.
    const images = collectImageDataUrls(payload);
    if (images.size) {
      const attestations = collectRedactionAttestations(payload);
      for (const image of images) {
        const attestation = attestations.get(image);
        if (!attestation) {
          throw new OutboundPolicyViolationError(
            'Outbound policy blocked payload: an image was included without a local redaction attestation.',
            { reason: 'unattested_image' }
          );
        }
        if (attestation.withheld) {
          throw new OutboundPolicyViolationError(
            'Outbound policy blocked payload: local redaction withheld this image; it must not be transmitted.',
            { reason: 'withheld_image' }
          );
        }
        if (!attestation.coverageEstablished) {
          throw new OutboundPolicyViolationError(
            'Outbound policy blocked payload: local redaction could not establish coverage over this image.',
            { reason: 'incomplete_coverage' }
          );
        }
        if (!attestation.localVisionCompleted) {
          throw new OutboundPolicyViolationError(
            'Outbound policy blocked payload: this image was not audited by local visual analysis.',
            { reason: 'unaudited_image' }
          );
        }
      }
    }

    const textLeaves = [];
    const piiTextLeaves = [];
    const collectText = (value, path = []) => {
      if (typeof value === 'string') {
        // Base64 image bytes are opaque to text patterns; the checks above
        // establish instead that each image was redacted and audited.
        if (!/^data:image\/[^;]+;base64,/i.test(value)) {
          textLeaves.push(value);
          if (path[path.length - 1] !== 'timestamp') piiTextLeaves.push(value);
        }
      }
      else if (Array.isArray(value)) value.forEach((item, index) => collectText(item, [...path, String(index)]));
      else if (value && typeof value === 'object') {
        Object.entries(value).forEach(([key, item]) => collectText(item, [...path, key]));
      }
    };
    collectText(payload);
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
    const matches = piiTextLeaves.flatMap((text) =>
      findPIIMatches(text, '').map((match) => ({ ...match, sourceText: text }))
    );
    const isBenignReference = (match) => {
      if (match.category !== 'AADHAAR') return false;
      const nearby = match.sourceText.slice(Math.max(0, match.index - 60), Math.min(match.sourceText.length, match.end + 60));
      return /\b(?:order|tracking|shipment|reference|invoice|booking|confirmation|reservation|ticket|case|record|product|serial|transaction|delivery|application)\b/i.test(nearby) &&
        !/\b(?:aadhaar|aadhar|uidai|unique\s+identity)\b/i.test(nearby);
    };
    const piiMatch = matches.find((match) => !isBenignReference(match));
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

/**
 * Find every inline base64 image in a payload, keyed by the exact string.
 * @returns {Set<string>}
 */
function collectImageDataUrls(payload) {
  const found = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      if (/^data:image\/[^;]+;base64,/i.test(value)) found.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(payload);
  return found;
}

/**
 * Collect the redaction attestation that must accompany each image.
 *
 * The controller records the local privacy audit it actually performed, and
 * the VLM client attaches that record next to the bytes it is about to send.
 * Requiring it here means the final local gate verifies the upstream claim
 * instead of assuming redaction succeeded.
 *
 * @returns {Map<string, {withheld: boolean, coverageEstablished: boolean, localVisionCompleted: boolean}>}
 */
function collectRedactionAttestations(payload) {
  const attestations = new Map();
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const audit = value.redaction_audit || value.privacy_redaction_summary;
    if (audit && typeof audit === 'object') {
      const image = value.image || value.sanitized_screenshot || value.screenshot;
      if (typeof image === 'string' && /^data:image\/[^;]+;base64,/i.test(image)) {
        attestations.set(image, {
          // An explicit `screenshot_withheld` flag means the sanitizer replaced
          // the image with a placeholder; those bytes must never be sent.
          withheld: audit.screenshot_withheld === true || audit.withheld === true,
          coverageEstablished: audit.coverage_established !== false,
          localVisionCompleted: audit.local_vision_completed !== false
        });
      }
    }
    Object.values(value).forEach(walk);
  };
  walk(payload);
  return attestations;
}

export const defaultPolicyEngine = new PolicyEngine();
