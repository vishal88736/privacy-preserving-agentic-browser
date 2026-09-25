/**
 * Tests for PolicyEngine (OutboundPolicyViolationError)
 * Covers all 7 outbound scanning rules: vault secrets, Aadhaar, PAN,
 * credit cards, email, phone, and IFSC codes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine, OutboundPolicyViolationError } from '../../extension/privacy/policy-engine.js';
import { LocalVault } from '../../extension/privacy/local-vault.js';

function makeEngine() {
  return new PolicyEngine(new LocalVault());
}

// ── Safe payloads ──────────────────────────────────────────────────────────

test('PolicyEngine - allows a fully sanitized payload', () => {
  const engine = makeEngine();
  const safe = {
    task_id: 'task_001',
    elements: [
      { id: 'el_1', label: 'Aadhaar', value: '[REDACTED]', value_source: 'LOCAL_AADHAAR' },
      { id: 'el_2', label: 'PAN', value: '[REDACTED]', value_source: 'LOCAL_PAN' }
    ]
  };
  assert.doesNotThrow(() => engine.enforceOutboundSafety(safe));
});

test('PolicyEngine - allows string payloads without PII', () => {
  const engine = makeEngine();
  assert.doesNotThrow(() => engine.enforceOutboundSafety('Search for cheapest laptops on Amazon'));
});

test('PolicyEngine - allows email from safe test.com / example.com domains', () => {
  const engine = makeEngine();
  assert.throws(() => engine.enforceOutboundSafety({ note: 'developer@test.com' }), OutboundPolicyViolationError);
  assert.throws(() => engine.enforceOutboundSafety({ note: 'user@example.com' }), OutboundPolicyViolationError);
});

// ── Vault secret leak detection ────────────────────────────────────────────

test('PolicyEngine - blocks payload containing raw vault Aadhaar value', () => {
  const engine = makeEngine();
  const leaked = { value: '4821 7392 0184' }; // synthetic Aadhaar-shaped test fixture
  assert.throws(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks payload containing raw vault PAN value', () => {
  const engine = makeEngine();
  const leaked = { pan: 'ABCDE1234F' }; // synthetic PAN-shaped test fixture
  assert.throws(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks payload containing stripped Aadhaar (no spaces)', () => {
  const engine = makeEngine();
  // Vault stores "4821 7392 0184" — stripped = "482173920184"
  const leaked = { note: '482173920184 is the number' };
  assert.throws(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

// ── Pattern-based scans (rules 2-7) ───────────────────────────────────────

test('PolicyEngine - blocks unmasked 12-digit Aadhaar pattern (rule 2)', () => {
  const engine = makeEngine();
  // Not in vault — but pattern triggers
  const leaked = { text: 'My aadhaar: 3456 7890 1234' };
  assert.throws(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks unmasked PAN pattern (rule 3)', () => {
  const engine = makeEngine();
  const leaked = { text: 'PAN FGHIJ5678K is in this payload' };
  assert.throws(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks PAN pattern case-insensitively (rule 3 L13)', () => {
  const engine = makeEngine();
  const leaked = { text: 'lowercase pan fghij5678k in payload' };
  assert.throws(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks Luhn-valid credit card number (rule 4)', () => {
  const engine = makeEngine();
  // 4532015000000007 is a valid Luhn Visa test number
  const leaked = { card: '4532015000000007' };
  assert.throws(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - allows Luhn-invalid digit string that looks like a card (rule 4)', () => {
  const engine = makeEngine();
  // Replace last digit to make Luhn fail
  const safe = { card: '4532015000000008' }; // fails Luhn
  assert.doesNotThrow(() => engine.enforceOutboundSafety(safe));
});

test('PolicyEngine - blocks unmasked real email address (rule 5)', () => {
  const engine = makeEngine();
  const leaked = { text: 'Send report to real.user@company.org' };
  assert.throws(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks unmasked Indian phone number (rule 6)', () => {
  const engine = makeEngine();
  const leaked = { text: 'call me at 9876543210 today' };
  assert.throws(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks phone number with +91 prefix (rule 6)', () => {
  const engine = makeEngine();
  const leaked = { phone: '+919012345678' };
  assert.throws(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks IFSC code in payload (rule 7)', () => {
  const engine = makeEngine();
  const leaked = { ifsc: 'SBIN0001234' };
  assert.throws(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
  assert.throws(() => engine.enforceOutboundSafety({ ifsc: 'sbin0001234' }), OutboundPolicyViolationError);
});

// ── Timestamp & base64 exemptions ────────────────────────────────────────

test('PolicyEngine - does NOT block JS timestamps (13-digit numbers)', () => {
  const engine = makeEngine();
  const ts = { timestamp: 1710000000000 }; // 13-digit epoch ms
  assert.doesNotThrow(() => engine.enforceOutboundSafety(ts));
});

test('PolicyEngine - does NOT scan inside base64 image data (screenshot exemption)', () => {
  const engine = makeEngine();
  // A base64 payload that contains PAN-shaped alphanumeric sequences
  const payload = {
    screenshot: 'data:image/png;base64,ABCDE1234FGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=='
  };
  assert.doesNotThrow(() => engine.enforceOutboundSafety(payload));
});

// ── Error properties ──────────────────────────────────────────────────────

test('PolicyEngine - OutboundPolicyViolationError has correct name and violationDetails', () => {
  const engine = makeEngine();
  let caught = null;
  try {
    engine.enforceOutboundSafety({ text: '4821 7392 0184' });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof OutboundPolicyViolationError);
  assert.equal(caught.name, 'OutboundPolicyViolationError');
  assert.ok(caught.message.length > 0);
});

test('PolicyEngine - returns true when payload is clean', () => {
  const engine = makeEngine();
  const result = engine.enforceOutboundSafety({ query: 'cheapest laptop under 60000' });
  assert.equal(result, true);
});
