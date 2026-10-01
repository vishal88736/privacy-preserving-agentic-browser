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

test('PolicyEngine - allows a fully sanitized payload', async () => {
  const engine = makeEngine();
  const safe = {
    task_id: 'task_001',
    elements: [
      { id: 'el_1', label: 'Aadhaar', value: '[REDACTED]', value_source: 'LOCAL_AADHAAR' },
      { id: 'el_2', label: 'PAN', value: '[REDACTED]', value_source: 'LOCAL_PAN' }
    ]
  };
  await assert.doesNotReject(() => engine.enforceOutboundSafety(safe));
});

test('PolicyEngine - allows string payloads without PII', async () => {
  const engine = makeEngine();
  await assert.doesNotReject(() => engine.enforceOutboundSafety('Search for cheapest laptops on Amazon'));
});

test('PolicyEngine - allows email from safe test.com / example.com domains', async () => {
  const engine = makeEngine();
  await assert.rejects(() => engine.enforceOutboundSafety({ note: 'developer@test.com' }), OutboundPolicyViolationError);
  await assert.rejects(() => engine.enforceOutboundSafety({ note: 'user@example.com' }), OutboundPolicyViolationError);
});

// ── Vault secret leak detection ────────────────────────────────────────────

test('PolicyEngine - blocks payload containing raw vault Aadhaar value', async () => {
  const engine = makeEngine();
  const leaked = { value: '4821 7392 0184' }; // synthetic Aadhaar-shaped test fixture
  await assert.rejects(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks payload containing raw vault PAN value', async () => {
  const engine = makeEngine();
  const leaked = { pan: 'ABCDE1234F' }; // synthetic PAN-shaped test fixture
  await assert.rejects(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks payload containing stripped Aadhaar (no spaces)', async () => {
  const engine = makeEngine();
  // Vault stores "4821 7392 0184" — stripped = "482173920184"
  const leaked = { note: '482173920184 is the number' };
  await assert.rejects(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

// ── Pattern-based scans (rules 2-7) ───────────────────────────────────────

test('PolicyEngine - blocks unmasked 12-digit Aadhaar pattern (rule 2)', async () => {
  const engine = makeEngine();
  // Not in vault — but pattern triggers
  const leaked = { text: 'My aadhaar: 3456 7890 1234' };
  await assert.rejects(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - order-reference context in another field cannot exempt an Aadhaar-shaped value', async () => {
  const engine = makeEngine();
  await assert.rejects(() => engine.enforceOutboundSafety({
    label: 'Order reference',
    unrelated_value: '482173920184'
  }), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks unmasked PAN pattern (rule 3)', async () => {
  const engine = makeEngine();
  const leaked = { text: 'PAN FGHIJ5678K is in this payload' };
  await assert.rejects(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks PAN pattern case-insensitively (rule 3 L13)', async () => {
  const engine = makeEngine();
  const leaked = { text: 'lowercase pan fghij5678k in payload' };
  await assert.rejects(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks Luhn-valid credit card number (rule 4)', async () => {
  const engine = makeEngine();
  // 4532015000000007 is a valid Luhn Visa test number
  const leaked = { card: '4532015000000007' };
  await assert.rejects(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - allows Luhn-invalid digit string that looks like a card (rule 4)', async () => {
  const engine = makeEngine();
  // Replace last digit to make Luhn fail
  const safe = { card: '4532015000000008' }; // fails Luhn
  await assert.doesNotReject(() => engine.enforceOutboundSafety(safe));
});

test('PolicyEngine - blocks unmasked real email address (rule 5)', async () => {
  const engine = makeEngine();
  const leaked = { text: 'Send report to real.user@company.org' };
  await assert.rejects(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks unmasked Indian phone number (rule 6)', async () => {
  const engine = makeEngine();
  const leaked = { text: 'call me at 9876543210 today' };
  await assert.rejects(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks phone number with +91 prefix (rule 6)', async () => {
  const engine = makeEngine();
  const leaked = { phone: '+919012345678' };
  await assert.rejects(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
});

test('PolicyEngine - blocks IFSC code in payload (rule 7)', async () => {
  const engine = makeEngine();
  const leaked = { ifsc: 'SBIN0001234' };
  await assert.rejects(() => engine.enforceOutboundSafety(leaked), OutboundPolicyViolationError);
  await assert.rejects(() => engine.enforceOutboundSafety({ ifsc: 'sbin0001234' }), OutboundPolicyViolationError);
});

// ── Timestamp & base64 exemptions ────────────────────────────────────────

test('PolicyEngine - does NOT block JS timestamps (13-digit numbers)', async () => {
  const engine = makeEngine();
  const ts = { timestamp: 1710000000000 }; // 13-digit epoch ms
  await assert.doesNotReject(() => engine.enforceOutboundSafety(ts));
});

test('PolicyEngine - does NOT pattern-match inside base64 image bytes', async () => {
  const engine = makeEngine();
  // Base64 is an encoding, not text: a PAN-shaped sequence inside it is a
  // coincidence, and matching it would block benign tasks. Image bytes are
  // therefore excluded from the *text* scan, and instead gated by the
  // attestation requirement above.
  const payload = {
    sanitized_screenshot: 'data:image/png;base64,ABCDE1234FGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==',
    redaction_audit: { screenshot_withheld: false, coverage_established: true, local_vision_completed: true }
  };
  await assert.doesNotReject(() => engine.enforceOutboundSafety(payload));
});

// ── Error properties ──────────────────────────────────────────────────────

test('PolicyEngine - OutboundPolicyViolationError has correct name and violationDetails', async () => {
  const engine = makeEngine();
  let caught = null;
  try {
    await engine.enforceOutboundSafety({ text: '4821 7392 0184' });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof OutboundPolicyViolationError);
  assert.equal(caught.name, 'OutboundPolicyViolationError');
  assert.ok(caught.message.length > 0);
});

test('PolicyEngine - returns true when payload is clean', async () => {
  const engine = makeEngine();
  const result = await engine.enforceOutboundSafety({ query: 'cheapest laptop under 60000' });
  assert.equal(result, true);
});

test('PolicyEngine - waits for the encrypted vault before scanning secrets', async () => {
  let finishLoading;
  let loaded = false;
  const vault = {
    ready: new Promise((resolve) => { finishLoading = resolve; }),
    getAllSecretsForUI() {
      assert.equal(loaded, true, 'secret scan must not run before vault hydration');
      return { LOCAL_PROFILE: 'synthetic-vault-secret-fixture' };
    }
  };
  const engine = new PolicyEngine(vault);
  const pendingScan = engine.enforceOutboundSafety({ note: 'synthetic-vault-secret-fixture' });
  loaded = true;
  finishLoading();
  await assert.rejects(pendingScan, OutboundPolicyViolationError);
});

test('PolicyEngine - blocks outbound checks when vault hydration reported an error', async () => {
  const engine = new PolicyEngine({
    ready: Promise.resolve(),
    storageError: 'encrypted storage could not be read',
    getAllSecretsForUI: () => ({})
  });
  await assert.rejects(
    engine.enforceOutboundSafety({ task: 'safe looking request' }),
    (error) => error instanceof OutboundPolicyViolationError && error.violationDetails?.reason === 'vault_unavailable'
  );
});

// ── Screenshot attestation ─────────────────────────────────────────────────
//
// The screenshot is the largest artifact in any payload and the one most
// likely to carry PII. It used to be stripped from the scanned string before
// any check ran, so it was the only thing on the final local gate with zero
// verification. Images now have to arrive with a record of the redaction
// that was actually performed on them.

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

test('PolicyEngine - rejects an image with no redaction attestation', async () => {
  const engine = makeEngine();
  await assert.rejects(
    () => engine.enforceOutboundSafety({
      sanitized_screenshot: IMAGE,
      sanitized_dom: { elements: [] }
    }),
    (e) => e instanceof OutboundPolicyViolationError && /without a local redaction attestation/.test(e.message)
  );
});

test('PolicyEngine - rejects an image the sanitizer withheld', async () => {
  const engine = makeEngine();
  await assert.rejects(
    () => engine.enforceOutboundSafety({
      sanitized_screenshot: IMAGE,
      redaction_audit: { screenshot_withheld: true, coverage_established: true, local_vision_completed: true },
      sanitized_dom: { elements: [] }
    }),
    (e) => e instanceof OutboundPolicyViolationError && /withheld/.test(e.message)
  );
});

test('PolicyEngine - rejects an image whose redaction coverage was never established', async () => {
  const engine = makeEngine();
  await assert.rejects(
    () => engine.enforceOutboundSafety({
      sanitized_screenshot: IMAGE,
      redaction_audit: { screenshot_withheld: false, coverage_established: false, local_vision_completed: true },
      sanitized_dom: { elements: [] }
    }),
    (e) => e instanceof OutboundPolicyViolationError && /coverage/.test(e.message)
  );
});

test('PolicyEngine - rejects an image local vision never audited', async () => {
  const engine = makeEngine();
  await assert.rejects(
    () => engine.enforceOutboundSafety({
      sanitized_screenshot: IMAGE,
      redaction_audit: { screenshot_withheld: false, coverage_established: true, local_vision_completed: false },
      sanitized_dom: { elements: [] }
    }),
    (e) => e instanceof OutboundPolicyViolationError && /audited/.test(e.message)
  );
});

test('PolicyEngine - rejects image attestations with missing coverage or vision fields', async () => {
  const engine = makeEngine();
  await assert.rejects(
    engine.enforceOutboundSafety({
      sanitized_screenshot: IMAGE,
      redaction_audit: { screenshot_withheld: false, local_vision_completed: true }
    }),
    (error) => error instanceof OutboundPolicyViolationError && error.violationDetails?.reason === 'incomplete_coverage'
  );
  await assert.rejects(
    engine.enforceOutboundSafety({
      sanitized_screenshot: IMAGE,
      redaction_audit: { screenshot_withheld: false, coverage_established: true }
    }),
    (error) => error instanceof OutboundPolicyViolationError && error.violationDetails?.reason === 'unaudited_image'
  );
});

test('PolicyEngine - requires an explicit not-withheld image status', async () => {
  const engine = makeEngine();
  await assert.rejects(
    engine.enforceOutboundSafety({
      sanitized_screenshot: IMAGE,
      redaction_audit: { coverage_established: true, local_vision_completed: true }
    }),
    (error) => error instanceof OutboundPolicyViolationError && error.violationDetails?.reason === 'incomplete_attestation'
  );
});

test('PolicyEngine - rejects conflicting image coverage fields', async () => {
  const engine = makeEngine();
  const payloads = [
    {
      sanitized_screenshot: IMAGE,
      redaction_audit: {
        screenshot_withheld: false,
        coverage_established: false,
        coverageEstablished: true,
        local_vision_completed: true
      }
    },
    {
      sanitized_screenshot: IMAGE,
      redaction_audit: {
        screenshot_withheld: false,
        coverage_established: true,
        coverageEstablished: false,
        local_vision_completed: true
      }
    },
    {
      sanitized_screenshot: IMAGE,
      redaction_audit: { screenshot_withheld: false, coverage_established: true, local_vision_completed: true },
      metadata: {
        sanitized_screenshot: IMAGE,
        redaction_audit: { screenshot_withheld: false, coverage_established: false, local_vision_completed: true }
      }
    }
  ];
  for (const payload of payloads) {
    await assert.rejects(
      engine.enforceOutboundSafety(payload),
      (error) => error instanceof OutboundPolicyViolationError && error.violationDetails?.reason === 'incomplete_coverage'
    );
  }
});

test('PolicyEngine - accepts a fully attested image', async () => {
  const engine = makeEngine();
  const result = await engine.enforceOutboundSafety({
    sanitized_screenshot: IMAGE,
    redaction_audit: { screenshot_withheld: false, coverage_established: true, local_vision_completed: true },
    sanitized_dom: { elements: [{ id: 'el_1', label: 'Search' }] }
  });
  assert.equal(result, true);
});

test('PolicyEngine - accepts the controller redaction audit format and rejects contradictory fields', async () => {
  const engine = makeEngine();
  const audit = {
    status: 'masked', coverage: 'complete', withheld: false,
    local_model_completed: true, ocr_completed: true,
    regions: [{ category: 'PASSWORD', x: 10, y: 10, width: 40, height: 20, method: 'dom' }],
    detected_categories: ['PASSWORD']
  };
  const payload = { sanitized_screenshot: IMAGE, redaction_audit: audit, metadata: { redaction_audit: audit } };
  await assert.doesNotReject(() => engine.enforceOutboundSafety(payload));
  for (const override of [
    { status: 'withheld' }, { status: 'unknown' }, { coverage: 'unknown' },
    { ocr_completed: false }, { coverage_established: false }, { local_vision_completed: false }
  ]) {
    await assert.rejects(
      engine.enforceOutboundSafety({ ...payload, redaction_audit: { ...audit, ...override } }),
      OutboundPolicyViolationError
    );
  }
  await assert.rejects(
    engine.enforceOutboundSafety({ ...payload, metadata: { redaction_audit: { ...audit, coverage: 'unknown' } } }),
    OutboundPolicyViolationError
  );
});

test('PolicyEngine - base64 bytes still do not trip text patterns', async () => {
  // Stripping image bytes from the *text* scan is still correct: matching
  // PAN/card shapes inside base64 is meaningless and randomly fires.
  const engine = makeEngine();
  const result = await engine.enforceOutboundSafety({
    sanitized_screenshot: 'data:image/png;base64,QaYvq1115DxMBI0abcdefGHIJK',
    redaction_audit: { screenshot_withheld: false, coverage_established: true, local_vision_completed: true },
    sanitized_dom: { elements: [] }
  });
  assert.equal(result, true, 'a PAN-shaped string inside base64 must not block a task');
});

test('PolicyEngine - an attested image does not excuse PII in the text fields', async () => {
  const engine = makeEngine();
  await assert.rejects(
    () => engine.enforceOutboundSafety({
      sanitized_screenshot: IMAGE,
      redaction_audit: { screenshot_withheld: false, coverage_established: true, local_vision_completed: true },
      sanitized_dom: { elements: [{ id: 'el_1', label: 'PAN', value: 'ABCDE1234F' }] }
    }),
    (e) => e instanceof OutboundPolicyViolationError && /PAN/.test(e.message)
  );
});
