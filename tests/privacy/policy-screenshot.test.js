import test from 'node:test';
import assert from 'node:assert';
import { PolicyEngine } from '../../extension/privacy/policy-engine.js';

// Deterministic pseudo-random base64 (seeded LCG) resembling a PNG data URL.
function fakeScreenshotDataUrl(chars = 60000, seed = 42) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = seed >>> 0;
  let out = '';
  for (let i = 0; i < chars; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out += alpha[s % 64];
  }
  // Splice a PAN-shaped coincidence into the bytes (as real captures do).
  out = out.slice(0, 1000) + 'QaYvq1115D' + out.slice(1010);
  return `data:image/png;base64,${out}`;
}

// A payload that would actually be sent: the image carries the redaction
// attestation the policy engine now requires. Without it the engine rejects
// the image outright rather than skipping it, so a screenshot can no longer
// ride along unverified.
function visionPayload(shot, extra = {}) {
  return {
    task_id: 'task_1',
    sanitized_screenshot: shot,
    redaction_audit: {
      screenshot_withheld: false,
      coverage_established: true,
      local_vision_completed: true
    },
    sanitized_dom: { elements: [{ id: 'el_1', tag: 'input', label: 'Search' }] },
    metadata: { timestamp: 0, title: 'Test', url: 'https://example.com/' },
    timestamp: 0,
    ...extra
  };
}

test('PolicyEngine - base64 screenshot bytes never trip PII patterns', async () => {
  const engine = new PolicyEngine();
  const shot = fakeScreenshotDataUrl();
  await assert.doesNotReject(() => engine.enforceOutboundSafety(visionPayload(shot)));
});

test('PolicyEngine - real PAN in text is still blocked beside a screenshot', async () => {
  const engine = new PolicyEngine();
  const shot = fakeScreenshotDataUrl();
  await assert.rejects(
    () => engine.enforceOutboundSafety(visionPayload(shot, { note: 'my pan is ABCDE1234F ok' })),
    /PAN/
  );
});

test('PolicyEngine - real Aadhaar in text is still blocked beside a screenshot', async () => {
  const engine = new PolicyEngine();
  const shot = fakeScreenshotDataUrl();
  await assert.rejects(
    () => engine.enforceOutboundSafety(visionPayload(shot, { note: 'aadhaar 4821 7392 0184' })),
    /Aadhaar|raw value/
  );
});

test('PolicyEngine - raw vault secret in text is still blocked beside a screenshot', async () => {
  const engine = new PolicyEngine();
  const shot = fakeScreenshotDataUrl();
  engine.vault.memoryStore.LOCAL_PROFILE = 'synthetic-vault-secret-fixture';
  const secrets = engine.vault.getAllSecretsForUI();
  const firstKey = 'LOCAL_PROFILE';
  await assert.rejects(
    () => engine.enforceOutboundSafety(visionPayload(shot, { text: `leak ${secrets[firstKey]} end` })),
    /raw value/
  );
});

test('PolicyEngine - an unredacted screenshot cannot ride along in a vision payload', async () => {
  // The screenshot is the largest artifact in the request and the one most
  // likely to carry PII. It used to be deleted from the scanned string before
  // any check ran, so a silent upstream redaction failure still reached the
  // wire. It must now arrive with proof, or not at all.
  const engine = new PolicyEngine();
  const shot = fakeScreenshotDataUrl();
  const { redaction_audit, ...withoutAttestation } = visionPayload(shot);
  await assert.rejects(
    () => engine.enforceOutboundSafety(withoutAttestation),
    /without a local redaction attestation/
  );
});

test('PolicyEngine - a withheld screenshot is never transmitted', async () => {
  const engine = new PolicyEngine();
  await assert.rejects(
    () => engine.enforceOutboundSafety(visionPayload(fakeScreenshotDataUrl(), {
      redaction_audit: { screenshot_withheld: true, coverage_established: true, local_vision_completed: true }
    })),
    /withheld/
  );
});
