import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenshotSanitizer } from '../../extension/privacy/screenshot-sanitizer.js';
import { DOMSanitizer } from '../../extension/privacy/dom-sanitizer.js';
import { LocalVault } from '../../extension/privacy/local-vault.js';
import { VLMClient } from '../../extension/perception/vlm-client.js';
import { BrowserExecutor } from '../../extension/content/browser-executor.js';

test('screenshot sanitizer masks known DOM region and never returns original bytes in non-canvas runtime', async () => {
  const raw = 'data:image/png;base64,U0VDUkVU';
  const sanitizer = new ScreenshotSanitizer();
  const result = await sanitizer.redactScreenshot(raw, [{ sensitive: true, bbox: [1,2,30,12], semantic_type: 'EMAIL' }], { width: 100, height: 100 }, { coverageEstablished: true });
  assert.notEqual(result, raw);
  assert.match(result, /^data:image\//);
  assert.equal(sanitizer.lastRedactionStatus, 'withheld');
});

test('screenshot sanitizer draws an opaque blackout over the detected DOM bounding box', async () => {
  const originals = { fetch: globalThis.fetch, bitmap: globalThis.createImageBitmap, canvas: globalThis.OffscreenCanvas };
  const fills = [];
  const context = { fillStyle: '', drawImage() {}, fillRect(...args) { fills.push({ style: this.fillStyle, args }); }, strokeRect() {}, fillText() {} };
  globalThis.fetch = async () => ({ blob: async () => ({}) });
  globalThis.createImageBitmap = async () => ({ width: 100, height: 100 });
  globalThis.OffscreenCanvas = class { constructor() {} getContext() { return context; } toDataURL() { return 'data:image/webp;base64,REENCODED'; } };
  try {
    const raw = 'data:image/png;base64,UElJ';
    const sanitizer = new ScreenshotSanitizer();
    const safe = await sanitizer.redactScreenshot(raw, [{ sensitive: true, bbox: [10, 20, 30, 15], semantic_type: 'PAN' }], { width: 100, height: 100 }, { coverageEstablished: true, localVisionCompleted: true });
    assert.equal(safe, 'data:image/webp;base64,REENCODED');
    assert.equal(sanitizer.lastRedactionStatus, 'masked');
    assert.ok(fills.some(x => x.style === '#000000' && x.args[0] <= 10 && x.args[1] <= 20 && x.args[2] >= 30 && x.args[3] >= 15));
    const checked = await sanitizer.redactScreenshot(raw, [{ sensitive: false, bbox: [0, 0, 10, 10] }], { width: 100, height: 100 }, { coverageEstablished: true, localVisionCompleted: true });
    assert.equal(checked, 'data:image/webp;base64,REENCODED');
    assert.equal(sanitizer.lastRedactionStatus, 'checked');
  } finally {
    globalThis.fetch = originals.fetch;
    if (originals.bitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = originals.bitmap;
    if (originals.canvas === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = originals.canvas;
  }
});

test('VLM request receives the masked screenshot and redacted DOM value', async () => {
  const raw = 'data:image/png;base64,UElJX1NFQ1JFVA==';
  const safeShot = await new ScreenshotSanitizer().redactScreenshot(raw, [{ sensitive: true, bbox: [4,5,40,15], semantic_type: 'PAN' }], { width: 100, height: 100 }, { coverageEstablished: true });
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ visual_observation: { provenance: 'DOM_PLUS_REAL_VLM', detected_elements: [] } }) };
  };
  try {
    const client = new VLMClient('http://localhost:8000');
    const result = await client.processVisuals('task', safeShot, { elements: [{ sensitive: true, value: '[REDACTED]', semantic_type: 'PAN' }], visible_text: '' });
    assert.notEqual(sent.sanitized_screenshot, raw);
    assert.equal(sent.sanitized_dom.elements[0].value, '[REDACTED]');
    assert.equal(result._source, 'DOM_PLUS_REAL_VLM');
  } finally { globalThis.fetch = originalFetch; }
});

test('screenshot fails closed for unlocated text, canvas surfaces, and unknown coverage', async () => {
  const sanitizer = new ScreenshotSanitizer();
  const raw = 'data:image/png;base64,UkFX';
  for (const audit of [{}, { coverageEstablished: true, unlocatedSensitiveText: true }, { coverageEstablished: true, opaqueVisualSurface: true }]) {
    const result = await sanitizer.redactScreenshot(raw, [], { width: 800, height: 600 }, audit);
    assert.notEqual(result, raw);
  }
});

test('even a page with no detected sensitive controls passes through image processing or fails closed', async () => {
  const raw = 'data:image/png;base64,UkFX';
  const result = await new ScreenshotSanitizer().redactScreenshot(raw, [{ sensitive: false, bbox: [0,0,20,20] }], { width: 800, height: 600 }, { coverageEstablished: true });
  assert.notEqual(result, raw);
});

test('ordinary visible PII is detected and sanitized when observable as page text', () => {
  const sanitizer = new DOMSanitizer();
  const raw = { visible_text: 'Contact Jane at jane@example.com or 9876543210. DOB 15/08/2002. PAN ABCDE1234F.' };
  const safe = sanitizer.sanitizePageExtras(raw);
  assert.doesNotMatch(safe.visible_text, /jane@example.com|9876543210|15\/08\/2002|ABCDE1234F/);
  assert.equal(sanitizer.hasUnlocatedSensitiveText(raw), true);
});

test('sensitive values outside semantic controls are found where pattern recognizable', () => {
  const sanitizer = new DOMSanitizer();
  const raw = { visible_text: 'Your API key: sk_live_1234567890abcdef123456' };
  assert.equal(sanitizer.hasUnlocatedSensitiveText(raw), true);
  assert.match(sanitizer.sanitizePageExtras(raw).visible_text, /REDACTED_API_KEY/);
});

test('unlocated card numbers, bearer tokens, and IFSC codes withhold the screenshot', async () => {
  const sanitizer = new DOMSanitizer();
  const screenshotSanitizer = new ScreenshotSanitizer();
  const rawScreenshot = 'data:image/png;base64,UkFX';
  const samples = [
    'Card number: 4532015000000007',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.synthetic-token-value',
    'Bank branch IFSC: sbin0001234'
  ];
  for (const visible_text of samples) {
    const audit = {
      coverageEstablished: true,
      unlocatedSensitiveText: sanitizer.hasUnlocatedSensitiveText({ visible_text })
    };
    assert.equal(audit.unlocatedSensitiveText, true, `Expected to detect ${visible_text}`);
    const safeScreenshot = await screenshotSanitizer.redactScreenshot(rawScreenshot, [], {}, audit);
    assert.notEqual(safeScreenshot, rawScreenshot);
  }
  assert.doesNotMatch(sanitizer.sanitizePageExtras({ visible_text: samples[0] }).visible_text, /4532015000000007/);
});

test('PII detection coverage is partial: labeled accounts are scrubbed, arbitrary names and financial prose are not', () => {
  const sanitizer = new DOMSanitizer();
  const known = sanitizer.sanitizeUserPrompt('Account number: 123456789012');
  assert.match(known, /REDACTED_ACCOUNT/);
  const unknown = sanitizer.sanitizeUserPrompt('Jane Doe lives at 10 Oak Road and earns $84,000 annually.');
  assert.equal(unknown, 'Jane Doe lives at 10 Oak Road and earns $84,000 annually.');
});

test('canvas privacy gap forces a neutral screenshot and does not claim OCR protection', async () => {
  const raw = 'data:image/png;base64,Y2FudmFzX3NlY3JldA==';
  const safe = await new ScreenshotSanitizer().redactScreenshot(raw, [], {}, { coverageEstablished: true, opaqueVisualSurface: true });
  assert.notEqual(safe, raw);
});

test('failed VLM request reports DOM_ONLY with no synthetic visual detections', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const client = new VLMClient('http://localhost:8000');
    client.policyEngine = { enforceOutboundSafety: () => true };
    const out = await client.processVisuals('task', 'data:image/png;base64,AA==', { elements: [], visible_text: '' });
    assert.equal(out._source, 'DOM_ONLY');
    assert.deepEqual(out.detected_elements, []);
  } finally { globalThis.fetch = originalFetch; }
});

test('local vault starts empty and cannot store unsupported document blobs', async () => {
  const vault = new LocalVault();
  assert.deepEqual(vault.getAllSecretsForUI(), {});
  await assert.rejects(vault.updateSecret('LOCAL_DOCUMENT', 'bytes'), /Unsupported vault key/);
  assert.equal(vault.resolveSecret('LOCAL_DOCUMENT'), null);
});

test('real document upload payload is rejected; synthetic demo is separately marked', async () => {
  const executor = Object.create(BrowserExecutor.prototype);
  await assert.rejects(executor._executeUpload({ files: null }, { name: 'passport.pdf', content: 'real bytes' }), /not supported|synthetic/i);
});
