/**
 * Outbound Privacy Policy Engine
 * Scans all outgoing network payloads before dispatch to ensure
 * no plaintext secrets, PII, or vault credentials bypass sanitization.
 *
 * L8: Now scans for credit card, email, phone, and IFSC patterns
 *     in addition to Aadhaar and PAN.
 */

import { defaultLocalVault } from './local-vault.js';
import { defaultPIIDetector, validateLuhn } from './pii-detector.js';

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
    const scannable = serialized.replace(/"timestamp":\d+/g, '"timestamp":0');

    // 1. Scan against all plaintext secrets currently held in the local vault
    // L11: getAllSecretsForUI now returns only string values, so no blob bloat
    const secrets = this.vault.getAllSecretsForUI();
    for (const [key, value] of Object.entries(secrets)) {
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

    // 2. Scan for unmasked Aadhaar numbers (12-digit pattern starting with 2-9, space or hyphen separated)
    const rawAadhaarMatch = scannable.match(/\b[2-9]\d{3}[\s-_]?\d{4}[\s-_]?\d{4}\b/);
    if (rawAadhaarMatch && !rawAadhaarMatch[0].includes('REDACTED')) {
      throw new OutboundPolicyViolationError(
        'Outbound policy blocked payload: Unmasked 12-digit Aadhaar pattern found in request body',
        { match: rawAadhaarMatch[0] }
      );
    }

    // 3. Scan for unmasked PAN numbers (L13: case-insensitive)
    const rawPANMatch = scannable.match(/\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/i);
    if (rawPANMatch) {
      throw new OutboundPolicyViolationError(
        'Outbound policy blocked payload: Unmasked PAN pattern found in request body',
        { match: rawPANMatch[0] }
      );
    }

    // L8: 4. Scan for credit card numbers (13-19 digits passing Luhn check)
    const cardMatches = scannable.matchAll(/(?<!\d)(?:\d[\s-]?){13,19}(?!\d)/g);
    for (const m of cardMatches) {
      const cleanDigits = m[0].replace(/[\s-]/g, '');
      if (/^\d{13,19}$/.test(cleanDigits) && validateLuhn(cleanDigits)) {
        throw new OutboundPolicyViolationError(
          'Outbound policy blocked payload: Unmasked credit/debit card number (Luhn-valid) found in request body',
          { match: cleanDigits.slice(0, 4) + '****' }
        );
      }
    }

    // L8: 5. Scan for unmasked email addresses
    const emailMatch = scannable.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
    if (emailMatch) {
      // Only flag if it's not in a known-safe context (like a domain reference)
      const emailStr = emailMatch[0];
      const isSafe = /example\.com|test\.com|localhost|placeholder/i.test(emailStr);
      if (!isSafe) {
        throw new OutboundPolicyViolationError(
          'Outbound policy blocked payload: Unmasked email address found in request body',
          { match: emailStr.replace(/(.{3}).*(@.*)/, '$1***$2') }
        );
      }
    }

    // L8: 6. Scan for unmasked Indian phone numbers (standalone 10 digits
    // starting 6-9, optionally with +91). (?<!\d)/(?!\d) prevent matching
    // substrings of timestamps, bbox coords, or longer IDs.
    const phoneMatch = scannable.match(/(?<!\d)(?:(?:\+|0{0,2})91[\s-]?)?[6-9]\d{9}(?!\d)/);
    if (phoneMatch) {
      const phoneStr = phoneMatch[0].replace(/[\s-]/g, '');
      // Avoid false positives on short numeric sequences that are element IDs or timestamps
      if (phoneStr.length >= 10 && !/el_\d|vis_\d|task_\d|obs_\d/.test(scannable.substring(Math.max(0, scannable.indexOf(phoneMatch[0]) - 20), scannable.indexOf(phoneMatch[0]) + phoneMatch[0].length + 5))) {
        throw new OutboundPolicyViolationError(
          'Outbound policy blocked payload: Unmasked Indian phone number pattern found in request body',
          { match: phoneStr.slice(0, 4) + '******' }
        );
      }
    }

    // L8: 7. Scan for IFSC codes
    const ifscMatch = scannable.match(/\b[A-Z]{4}0[A-Z0-9]{6}\b/);
    if (ifscMatch) {
      throw new OutboundPolicyViolationError(
        'Outbound policy blocked payload: Unmasked IFSC code found in request body',
        { match: ifscMatch[0] }
      );
    }

    return true;
  }
}

export const defaultPolicyEngine = new PolicyEngine();
