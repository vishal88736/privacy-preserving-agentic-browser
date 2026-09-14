/**
 * Outbound Privacy Policy Engine
 * Scans all outgoing network payloads before dispatch to ensure
 * no plaintext secrets, PII, or vault credentials bypass sanitization.
 */

import { defaultLocalVault } from './local-vault.js';
import { defaultPIIDetector } from './pii-detector.js';

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

    // 1. Scan against all plaintext secrets currently held in the local vault
    const secrets = this.vault.getAllSecretsForUI();
    for (const [key, value] of Object.entries(secrets)) {
      if (typeof value === 'string' && value.length >= 4) {
        // Check raw inclusion
        if (serialized.includes(value)) {
          throw new OutboundPolicyViolationError(
            `Outbound policy blocked payload: Contains raw value of ${key}`,
            { key }
          );
        }
        // Also check clean alphanumeric format (e.g. without spaces for Aadhaar)
        const cleanVal = value.replace(/[\s-]/g, '');
        if (cleanVal.length >= 6 && serialized.includes(cleanVal)) {
          throw new OutboundPolicyViolationError(
            `Outbound policy blocked payload: Contains stripped value of ${key}`,
            { key }
          );
        }
      }
    }

    // 2. Scan for unmasked Aadhaar numbers
    const rawAadhaarMatch = serialized.match(/\b[2-9]\d{3}\s?\d{4}\s?\d{4}\b/);
    if (rawAadhaarMatch && !rawAadhaarMatch[0].includes('REDACTED')) {
      throw new OutboundPolicyViolationError(
        'Outbound policy blocked payload: Unmasked 12-digit Aadhaar pattern found in request body',
        { match: rawAadhaarMatch[0] }
      );
    }

    // 3. Scan for unmasked PAN numbers
    const rawPANMatch = serialized.match(/\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/);
    if (rawPANMatch) {
      throw new OutboundPolicyViolationError(
        'Outbound policy blocked payload: Unmasked PAN pattern found in request body',
        { match: rawPANMatch[0] }
      );
    }

    return true;
  }
}

export const defaultPolicyEngine = new PolicyEngine();
