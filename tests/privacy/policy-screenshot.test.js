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

function visionPayload(shot, extra = {}) {
  return {
    task_id: 'task_1',
    sanitized_screenshot: shot,
    sanitized_dom: { elements: [{ id: 'el_1', tag: 'input', label: 'Search' }] },
    metadata: { timestamp: 0, title: 'Test', url: 'https://example.com/' },
    timestamp: 0,
    ...extra
  };
}

test('PolicyEngine - base64 screenshot bytes never trip PII patterns', () => {
  const engine = new PolicyEngine();
  const shot = fakeScreenshotDataUrl();
  assert.doesNotThrow(() => engine.enforceOutboundSafety(visionPayload(shot)));
});

test('PolicyEngine - real PAN in text is still blocked beside a screenshot', () => {
  const engine = new PolicyEngine();
  const shot = fakeScreenshotDataUrl();
  assert.throws(
    () => engine.enforceOutboundSafety(visionPayload(shot, { note: 'my pan is ABCDE1234F ok' })),
    /PAN/
  );
});

test('PolicyEngine - real Aadhaar in text is still blocked beside a screenshot', () => {
  const engine = new PolicyEngine();
  const shot = fakeScreenshotDataUrl();
  assert.throws(
    () => engine.enforceOutboundSafety(visionPayload(shot, { note: 'aadhaar 4821 7392 0184' })),
    /Aadhaar|raw value/
  );
});

test('PolicyEngine - raw vault secret in text is still blocked beside a screenshot', () => {
  const engine = new PolicyEngine();
  const shot = fakeScreenshotDataUrl();
  engine.vault.memoryStore.LOCAL_PROFILE = 'synthetic-vault-secret-fixture';
  const secrets = engine.vault.getAllSecretsForUI();
  const firstKey = 'LOCAL_PROFILE';
  assert.throws(
    () => engine.enforceOutboundSafety(visionPayload(shot, { text: `leak ${secrets[firstKey]} end` })),
    /raw value/
  );
});
