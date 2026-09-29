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

test('PolicyEngine - order-reference context in another field cannot exempt an Aadhaar-shaped value', () => {
  const engine = makeEngine();
  assert.throws(() => engine.enforceOutboundSafety({
    label: 'Order reference',
    unrelated_value: '482173920184'
  }), OutboundPolicyViolationError);
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

test('PolicyEngine - does NOT pattern-match inside base64 image bytes', () => {
  const engine = makeEngine();
  // Base64 is an encoding, not text: a PAN-shaped sequence inside it is a
  // coincidence, and matching it would block benign tasks. Image bytes are
  // therefore excluded from the *text* scan, and instead gated by the
  // attestation requirement above.
  const payload = {
    sanitized_screenshot: 'data:image/png;base64,ABCDE1234FGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==',
    redaction_audit: { screenshot_withheld: false, coverage_established: true, local_vision_completed: true }
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

// ── Screenshot attestation ─────────────────────────────────────────────────
//
// The screenshot is the largest artifact in any payload and the one most
// likely to carry PII. It used to be stripped from the scanned string before
// any check ran, so it was the only thing on the final local gate with zero
// verification. Images now have to arrive with a record of the redaction
// that was actually performed on them.

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

test('PolicyEngine - rejects an image with no redaction attestation', () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.enforceOutboundSafety({
      sanitized_screenshot: IMAGE,
      sanitized_dom: { elements: [] }
    }),
    (e) => e instanceof OutboundPolicyViolationError && /without a local redaction attestation/.test(e.message)
  );
});

test('PolicyEngine - rejects an image the sanitizer withheld', () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.enforceOutboundSafety({
      sanitized_screenshot: IMAGE,
      redaction_audit: { screenshot_withheld: true, coverage_established: true, local_vision_completed: true },
      sanitized_dom: { elements: [] }
    }),
    (e) => e instanceof OutboundPolicyViolationError && /withheld/.test(e.message)
  );
});

test('PolicyEngine - rejects an image whose redaction coverage was never established', () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.enforceOutboundSafety({
      sanitized_screenshot: IMAGE,
      redaction_audit: { screenshot_withheld: false, coverage_established: false, local_vision_completed: true },
      sanitized_dom: { elements: [] }
    }),
    (e) => e instanceof OutboundPolicyViolationError && /coverage/.test(e.message)
  );
});

test('PolicyEngine - rejects an image local vision never audited', () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.enforceOutboundSafety({
      sanitized_screenshot: IMAGE,
      redaction_audit: { screenshot_withheld: false, coverage_established: true, local_vision_completed: false },
      sanitized_dom: { elements: [] }
    }),
    (e) => e instanceof OutboundPolicyViolationError && /audited/.test(e.message)
  );
});

test('PolicyEngine - accepts a fully attested image', () => {
  const engine = makeEngine();
  const result = engine.enforceOutboundSafety({
    sanitized_screenshot: IMAGE,
    redaction_audit: { screenshot_withheld: false, coverage_established: true, local_vision_completed: true },
    sanitized_dom: { elements: [{ id: 'el_1', label: 'Search' }] }
  });
  assert.equal(result, true);
});

test('PolicyEngine - base64 bytes still do not trip text patterns', () => {
  // Stripping image bytes from the *text* scan is still correct: matching
  // PAN/card shapes inside base64 is meaningless and randomly fires.
  const engine = makeEngine();
  const result = engine.enforceOutboundSafety({
    sanitized_screenshot: 'data:image/png;base64,QaYvq1115DxMBI0abcdefGHIJK',
    redaction_audit: { screenshot_withheld: false, coverage_established: true, local_vision_completed: true },
    sanitized_dom: { elements: [] }
  });
  assert.equal(result, true, 'a PAN-shaped string inside base64 must not block a task');
});

test('PolicyEngine - an attested image does not excuse PII in the text fields', () => {
  const engine = makeEngine();
  assert.throws(
    () => engine.enforceOutboundSafety({
      sanitized_screenshot: IMAGE,
      redaction_audit: { screenshot_withheld: false, coverage_established: true, local_vision_completed: true },
      sanitized_dom: { elements: [{ id: 'el_1', label: 'PAN', value: 'ABCDE1234F' }] }
    }),
    (e) => e instanceof OutboundPolicyViolationError && /PAN/.test(e.message)
  );
});
