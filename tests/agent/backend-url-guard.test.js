/**
 * The backend URL decides where sanitized page context is sent. It is the
 * largest egress surface in the extension, so it is validated on save and
 * refuses to leave the device unless the user explicitly opts in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBackendUrl, DEFAULT_SETTINGS } from '../../extension/background/task-manager.js';

test('loopback backends are accepted', () => {
  for (const url of [
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'https://127.0.0.1',
    'http://[::1]:8000',
    'http://127.1.2.3:8000'
  ]) {
    assert.equal(validateBackendUrl(url).valid, true, `should accept ${url}`);
  }
});

test('non-loopback hosts are refused by default with an actionable reason', () => {
  const result = validateBackendUrl('https://api.example.com');
  assert.equal(result.valid, false);
  assert.match(result.reason, /non-loopback/i);
  assert.match(result.reason, /Allow a remote backend/);
  assert.equal(result.url, null);
});

test('a non-loopback host is permitted only with an explicit opt-in', () => {
  assert.equal(validateBackendUrl('https://api.example.com', { allowRemote: true }).valid, true);
});

test('non-http schemes are refused even with the remote opt-in', () => {
  // file://, chrome:// and data: would let a setting name a non-network
  // target, which is never a legitimate backend.
  for (const url of ['file:///etc/passwd', 'chrome://settings', 'data:text/plain,x', 'ftp://host/x', 'javascript:alert(1)']) {
    const r = validateBackendUrl(url, { allowRemote: true });
    assert.equal(r.valid, false, `should refuse ${url}`);
  }
});

test('garbage and empty input are refused without throwing', () => {
  for (const url of ['', '   ', 'not a url', '//localhost', null, undefined, 123]) {
    assert.doesNotThrow(() => validateBackendUrl(url));
    assert.equal(validateBackendUrl(url).valid, false);
  }
});

test('a trailing slash is normalized so URL joins do not double up', () => {
  assert.equal(validateBackendUrl('http://localhost:8000/').url, 'http://localhost:8000');
  assert.equal(validateBackendUrl('http://localhost:8000///').url, 'http://localhost:8000');
});

test('remote backends are off by default', () => {
  assert.equal(DEFAULT_SETTINGS.allowRemoteBackend, false);
  assert.equal(DEFAULT_SETTINGS.backendUrl, 'http://localhost:8000');
});
