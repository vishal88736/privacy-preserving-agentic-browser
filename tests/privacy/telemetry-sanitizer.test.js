import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTelemetry } from '../../extension/privacy/telemetry-sanitizer.js';

test('telemetry sanitization removes PII from thoughts, values, and errors', () => {
  const raw = {
    thought: 'Use PAN ABCDE1234F and email jane@example.com',
    action: {
      action: 'TYPE',
      value: 'Aadhaar 4821 7392 0184',
      value_source: 'LOCAL_AADHAAR',
      target: { element_id: 'el_1', label: 'Aadhaar number' }
    },
    error: 'The page echoed 9876543210 while processing the field.'
  };
  const safe = sanitizeTelemetry(raw);
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, /ABCDE1234F|jane@example\.com|4821\s*7392\s*0184|9876543210/);
  assert.equal(safe.action.value_source, 'LOCAL_AADHAAR');
  assert.equal(safe.action.target.element_id, 'el_1');
});

test('telemetry sanitization preserves redacted screenshot previews but omits document bytes', () => {
  const safe = sanitizeTelemetry({
    sanitized_screenshot: 'data:image/webp;base64,REDACTED',
    resolvedValue: { __vaultDocument: true, bytes: [1, 2, 3], name: 'LOCAL_DOCUMENT_ID' }
  });
  assert.equal(safe.sanitized_screenshot, 'data:image/webp;base64,REDACTED');
  assert.equal(safe.resolvedValue.bytes, '[omitted]');
  assert.equal(safe.resolvedValue.name, 'LOCAL_DOCUMENT_ID');
});
