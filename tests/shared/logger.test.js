/**
 * Tests for shared/logger.js.
 *
 * The logger is the one component every other module depends on and the one
 * component that is hardest to notice when it is wrong: a redaction regression
 * here does not throw, it quietly writes a secret to disk. The privacy
 * assertions below are therefore the point of this file, not the formatting.
 *
 * Console output is captured rather than silenced so the "one pre-formatted
 * string" contract — which the e2e suites and the console-override tests rely
 * on — is asserted rather than assumed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLogExport,
  collectLogEntries,
  createLogger,
  formatConsoleLine,
  getLogStore,
  installGlobalErrorHandlers,
  levelEnabled,
  LogLevel,
  LogStore,
  logStorageKey,
  normalizeLevel,
  redactLogText,
  sanitizeFields,
  serializeEntry,
  serializeError
} from '../../extension/shared/logger.js';

/** Swap console methods for recorders, run fn, restore. */
function captureConsole(fn) {
  const original = {};
  const lines = [];
  for (const method of ['log', 'debug', 'warn', 'error']) {
    original[method] = console[method];
    console[method] = (...parts) => lines.push({ method, text: parts.join(' ') });
  }
  try {
    fn(lines);
  } finally {
    Object.assign(console, original);
  }
  return lines;
}

/** A LogStore with no storage, so nothing leaks between tests. */
function memoryStore(options = {}) {
  return new LogStore({ storage: null, ...options });
}

// ── Redaction ─────────────────────────────────────────────────────────────

test('redactLogText removes provider API key shapes', () => {
  for (const secret of [
    'sk-or-v1-abcdefghijklmnopqrstuvwx',
    'sk-proj-abcdefghijklmnopqrst',
    'gsk_ABCDEFGHIJKLMNOPQRST',
    'hf_abcdefghijklmnopqrstuvwxyz01',
    'pk-live-abcdefghij1234'
  ]) {
    const out = redactLogText(`failed using ${secret} today`);
    assert.ok(!out.includes(secret), `leaked ${secret}`);
    assert.match(out, /\[REDACTED_API_KEY\]/);
  }
});

test('redactLogText keeps the header but not the credential', () => {
  assert.equal(
    redactLogText('Authorization: Bearer abcdef0123456789xyz'),
    'Authorization: [REDACTED_BEARER_TOKEN]'
  );
  assert.equal(
    redactLogText('X-PrivAgent-Token: 4f8a2b9c1d6e7f0a3b5c8d2e'),
    'X-PrivAgent-Token: [REDACTED_BACKEND_TOKEN]'
  );
  assert.equal(redactLogText('password: hunter2xyz'), 'password: [REDACTED_ASSIGNED_SECRET]');
});

test('redactLogText strips screenshot data URLs', () => {
  const url = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAY';
  const out = redactLogText(`capture returned ${url}`);
  assert.ok(!out.includes('iVBORw0KGgo'));
  assert.match(out, /\[REDACTED_DATA_URL\]/);
});

test('redactLogText applies the extension PII rules, not just credential shapes', () => {
  // These are the categories privacy_rules/pii-rules.js already enforce on the
  // outbound path. A log entry quoting a form value must be scrubbed the same
  // way, or the log becomes the leak the sanitizer exists to prevent.
  assert.doesNotMatch(redactLogText('aadhaar 2345 6789 0123 submitted'), /2345/);
  assert.doesNotMatch(redactLogText('mail it to synthetic.person@example.invalid'), /example\.invalid/);
  assert.doesNotMatch(redactLogText('card 4111111111111111 charged'), /4111111111111111/);
});

test('redactLogText leaves ordinary diagnostic text intact', () => {
  for (const text of [
    'Content script initialized.',
    'NAVIGATION',
    'Posting to /reason; fields=task,fused_observation',
    'Step failed; recovering by re-observing'
  ]) {
    assert.equal(redactLogText(text), text);
  }
});

test('redactLogText is idempotent, so a marker is never re-wrapped', () => {
  // The logger redacts on write and the export path can redact again. If this
  // were not stable the file would accumulate nested markers on every pass.
  const once = redactLogText('Authorization: Bearer abcdef0123456789xyz');
  assert.equal(redactLogText(once), once);
  const pii = redactLogText('aadhaar 2345 6789 0123');
  assert.equal(redactLogText(pii), pii);
});

test('redactLogText caps runaway text', () => {
  const out = redactLogText('x'.repeat(9000));
  assert.ok(out.length < 3000, `expected a cap, got ${out.length} chars`);
  assert.match(out, /\[truncated\]$/);
});

test('redactLogText tolerates null and undefined', () => {
  assert.equal(redactLogText(null), null);
  assert.equal(redactLogText(undefined), undefined);
});

// ── Error serialization ───────────────────────────────────────────────────

test('serializeError keeps name, message and stack', () => {
  const error = new TypeError('bad thing');
  const out = serializeError(error);
  assert.equal(out.name, 'TypeError');
  assert.equal(out.message, 'bad thing');
  assert.ok(out.stack.includes('TypeError: bad thing'));
});

test('serializeError redacts credentials inside the error message', () => {
  const out = serializeError(new Error('request failed for sk-or-v1-abcdefghijklmnopqrst'));
  assert.ok(!out.message.includes('abcdefghijklmnop'));
});

test('serializeError drops custom properties that quote page content', () => {
  // OutboundPolicyViolationError.violationDetails carries the matched value.
  // Custom error attributes must not reach the log file.
  const error = new Error('outbound policy');
  error.violationDetails = { rawValue: 'a.b@example.invalid' };
  error.requestBody = 'SECRET';
  const out = serializeError(error);
  assert.deepEqual(Object.keys(out).sort(), ['message', 'name', 'stack']);
});

test('serializeError handles strings, primitives and null', () => {
  assert.equal(serializeError('plain').message, 'plain');
  assert.equal(serializeError(null), null);
  assert.ok(serializeError(42).message);
});

// ── Field sanitization ────────────────────────────────────────────────────

test('sanitizeFields survives cycles', () => {
  const node = { name: 'root' };
  node.self = node;
  const out = sanitizeFields(node);
  assert.equal(out.name, 'root');
  assert.equal(out.self, '[circular]');
});

test('sanitizeFields bounds depth instead of recursing forever', () => {
  let deep = { value: 'bottom' };
  for (let i = 0; i < 12; i += 1) deep = { nested: deep };
  const out = sanitizeFields(deep);
  assert.ok(JSON.stringify(out).includes('[depth-limited]'));
});

test('sanitizeFields caps array and object width with a count of the remainder', () => {
  const out = sanitizeFields({ items: Array.from({ length: 120 }, (_, i) => i) });
  assert.equal(out.items.length, 51);
  assert.equal(out.items[50], '[+70 more]');
});

test('sanitizeFields converts Errors, Maps, Sets and functions', () => {
  assert.equal(sanitizeFields(new RangeError('nope')).name, 'RangeError');
  assert.deepEqual(sanitizeFields(new Set([1, 2])), [1, 2]);
  assert.deepEqual(sanitizeFields(new Map([['a', 1]])), { a: 1 });
  assert.match(sanitizeFields(function named() {}), /\[function named\]/);
  assert.equal(sanitizeFields(10n), '10n');
  assert.equal(sanitizeFields(Number.NaN), 'NaN');
});

test('sanitizeFields redacts values, not just the message', () => {
  const out = sanitizeFields({ token: 'gsk_ABCDEFGHIJKLMNOPQRST', note: 'aadhaar 2345 6789 0123' });
  assert.ok(!out.token.includes('ABCDEFGHIJKL'));
  assert.ok(!out.note.includes('2345'));
});

// ── Levels ────────────────────────────────────────────────────────────────

test('normalizeLevel falls back rather than silencing logs', () => {
  assert.equal(normalizeLevel('debug'), 'debug');
  assert.equal(normalizeLevel('WARN'), 'warn');
  assert.equal(normalizeLevel('nonsense'), 'info');
  assert.equal(normalizeLevel(undefined), 'info');
  assert.equal(normalizeLevel(null), 'info');
});

test('levelEnabled orders levels', () => {
  assert.equal(levelEnabled('error', 'warn'), true);
  assert.equal(levelEnabled('warn', 'warn'), true);
  assert.equal(levelEnabled('info', 'warn'), false);
  assert.equal(levelEnabled('debug', 'info'), false);
});

test('a logger filters records below its level', () => {
  const store = memoryStore();
  const log = createLogger({ scope: 'T', surface: 'unit', store, level: 'warn' });
  captureConsole(() => {
    assert.equal(log.debug('no'), null);
    assert.equal(log.info('no'), null);
    assert.ok(log.warn('yes'));
    assert.ok(log.error('yes'));
  });
  assert.equal(store.all().length, 2);
});

test('debug level is reachable when explicitly enabled', () => {
  const store = memoryStore();
  const log = createLogger({ scope: 'T', surface: 'unit', store, level: 'debug' });
  const lines = captureConsole(() => { log.debug('verbose detail'); });
  assert.equal(lines[0].method, 'debug');
  assert.equal(store.all().length, 1);
});

// ── Records ───────────────────────────────────────────────────────────────

test('a record carries level, scope, surface and a monotonic sequence', () => {
  const store = memoryStore();
  const log = createLogger({ scope: 'AgentController', surface: 'background', store });
  captureConsole(() => {
    log.info('first');
    log.info('second');
  });
  const [a, b] = store.all();
  assert.equal(a.level, 'info');
  assert.equal(a.scope, 'AgentController');
  assert.equal(a.surface, 'background');
  assert.equal(b.seq, a.seq + 1);
  assert.ok(Date.parse(a.ts) > 0);
});

test('logger.exception records the error separately from the message', () => {
  const store = memoryStore();
  const log = createLogger({ scope: 'T', surface: 'unit', store });
  let entry;
  captureConsole(() => {
    entry = log.exception('Value resolver failed', new RangeError('bad'), { field: 'aad' });
  });
  assert.equal(entry.level, 'error');
  assert.equal(entry.message, 'Value resolver failed');
  assert.equal(entry.error.name, 'RangeError');
  // `error` must not also be duplicated into fields.
  assert.equal(entry.fields.error, undefined);
  assert.equal(entry.fields.field, 'aad');
});

test('setContext stamps later records and null clears a key', () => {
  const store = memoryStore();
  const log = createLogger({ scope: 'T', surface: 'unit', store });
  captureConsole(() => {
    log.setContext({ task_id: 'task_1', tab_id: 7 });
    log.info('during task');
    log.setContext({ tab_id: null });
    log.info('after clear');
  });
  const [a, b] = store.all();
  assert.deepEqual(a.context, { task_id: 'task_1', tab_id: 7 });
  assert.deepEqual(b.context, { task_id: 'task_1' });
});

test('child loggers inherit and extend the scope and context', () => {
  const store = memoryStore();
  const parent = createLogger({ scope: 'Root', surface: 'unit', store });
  parent.setContext({ task_id: 'task_1' });
  const child = parent.child('Sub');
  assert.equal(child.scope, 'Root.Sub');
  assert.equal(child.surface, 'unit');
  assert.equal(child.store, store);
  assert.deepEqual(child.context, { task_id: 'task_1' });
});

// ── Console contract ──────────────────────────────────────────────────────

test('formatConsoleLine is a single readable line per level', () => {
  const line = formatConsoleLine({
    level: 'warn', scope: 'LocalVault', message: 'Resolving LOCAL_AADHAAR -> (configured, kept local)',
    fields: { a: 1 }, context: { task_id: 't' }, error: null
  });
  assert.equal(line, 'WARN [LocalVault] Resolving LOCAL_AADHAAR -> (configured, kept local) {"a":1} {"task_id":"t"}');
});

test('each level is mirrored to the matching console method', () => {
  const store = memoryStore();
  const log = createLogger({ scope: 'T', surface: 'unit', store, level: 'debug' });
  const lines = captureConsole(() => {
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
  });
  assert.deepEqual(lines.map((l) => l.method), ['debug', 'log', 'warn', 'error']);
});

test('the console receives one pre-formatted string, not format arguments', () => {
  // tests/reasoning/form-plan-builder.test.js overrides console.debug and joins
  // the parts; passing a format plus arguments would change what it captures.
  const store = memoryStore();
  const log = createLogger({ scope: 'T', surface: 'unit', store, level: 'debug' });
  let argCount = null;
  const original = console.debug;
  console.debug = (...parts) => { argCount = parts.length; };
  try { log.debug('one arg only'); } finally { console.debug = original; }
  assert.equal(argCount, 1);
});

test('the scope and message survive to the console verbatim', () => {
  // tests/e2e_full_suite.py and tests/e2e_master_hardening_suite.py assert on
  // "Content script initialized" in the page console.
  const store = memoryStore();
  const log = createLogger({ scope: 'PrivacyAgent', surface: 'unit', store });
  const lines = captureConsole(() => { log.info('Content script initialized.'); });
  assert.ok(lines[0].text.includes('Content script initialized.'));
});

test('a throwing console does not break the caller', () => {
  const store = memoryStore();
  const log = createLogger({ scope: 'T', surface: 'unit', store });
  const original = console.log;
  console.log = () => { throw new Error('console is gone'); };
  let entry;
  try {
    entry = log.info('still recorded');
  } finally {
    console.log = original;
  }
  assert.ok(entry, 'the record must survive a hostile console');
  assert.equal(store.all().length, 1);
});

// ── Store ─────────────────────────────────────────────────────────────────

test('the store trims from the front and keeps the sequence monotonic', () => {
  const store = memoryStore({ maxEntries: 3 });
  const log = createLogger({ scope: 'T', surface: 'unit', store });
  captureConsole(() => {
    for (let i = 0; i < 6; i += 1) log.info(`line ${i}`);
  });
  const entries = store.all();
  assert.equal(entries.length, 3);
  assert.equal(entries[0].message, 'line 3');
  assert.equal(entries[2].seq, 6);
});

test('each surface persists under its own storage key', () => {
  // The worker and the side panel share one chrome.storage.local. A single key
  // would mean each context's flush overwrites the other's log.
  assert.notEqual(logStorageKey('background'), logStorageKey('sidepanel'));
  assert.equal(logStorageKey('background'), 'privagent_logs:background');
});

test('getLogStore returns one store per surface and a fresh one for overrides', () => {
  assert.equal(getLogStore('x'), getLogStore('x'));
  assert.notEqual(getLogStore('x'), getLogStore('y'));
  const custom = getLogStore('x', { storage: null });
  assert.notEqual(custom, getLogStore('x'));
});

test('hydrate restores persisted entries and rejects non-record values', async () => {
  const written = {};
  const area = {
    get: async (key) => ({ [key]: written[key] }),
    set: async (obj) => { Object.assign(written, obj); }
  };
  const store = new LogStore({ storageKey: 'k', storage: area });
  await store.hydrate();
  const log = createLogger({ scope: 'T', surface: 'unit', store });
  captureConsole(() => { log.info('persisted'); });
  await store.flush();

  const restored = new LogStore({ storageKey: 'k', storage: area });
  await restored.hydrate();
  assert.equal(restored.all().length, 1);
  assert.equal(restored.all()[0].message, 'persisted');
  // Sequence numbers must continue rather than restart, or the export merge
  // cannot order two surfaces against each other.
  assert.ok(restored.nextSeq() > 1);

  written.k = [null, 'garbage', { message: 'kept' }];
  const filtered = new LogStore({ storageKey: 'k', storage: area });
  await filtered.hydrate();
  assert.equal(filtered.all().length, 1);
});

test('a storage failure degrades to in-memory logging', async () => {
  const area = {
    get: async () => { throw new Error('storage revoked'); },
    set: async () => { throw new Error('quota exceeded'); }
  };
  const store = new LogStore({ storageKey: 'k', storage: area });
  await store.hydrate();
  const log = createLogger({ scope: 'T', surface: 'unit', store });
  captureConsole(() => { log.warn('survives a dead storage area'); });
  await store.flush();
  assert.equal(store.all().length, 1);
});

test('a missing chrome.storage area is not an error', async () => {
  const store = new LogStore({ storageKey: 'k', storage: null });
  await assert.doesNotReject(store.hydrate());
  await assert.doesNotReject(store.flush());
});

test('clear empties the buffer', async () => {
  const store = memoryStore();
  const log = createLogger({ scope: 'T', surface: 'unit', store });
  captureConsole(() => { log.info('x'); });
  store.clear();
  assert.equal(store.all().length, 0);
});

// ── Serialization and export ──────────────────────────────────────────────

test('serializeEntry emits one JSON object per line', () => {
  const entry = {
    ts: '2026-01-01T00:00:00.000Z', epoch_ms: 1, seq: 2, level: 'error',
    surface: 'background', scope: 'T', message: 'boom',
    fields: { a: 1 }, context: { task_id: 't' },
    error: { name: 'TypeError', message: 'bad' }
  };
  const line = serializeEntry(entry);
  assert.ok(!line.includes('\n'), 'a record must not span lines');
  const parsed = JSON.parse(line);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.error.name, 'TypeError');
  // Empty fields/context collapse to null rather than being omitted, so the
  // record schema is stable and a consumer never has to test for key presence.
  const empty = JSON.parse(serializeEntry({ ...entry, fields: {}, context: {} }));
  assert.equal(empty.fields, null);
  assert.equal(empty.context, null);
});

test('serializeEntry does not throw on a cyclic payload', () => {
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  const line = serializeEntry({ ts: '', epoch_ms: 1, seq: 1, level: 'info', message: 'm', fields: cyclic });
  assert.doesNotThrow(() => JSON.parse(line));
});

test('buildLogExport writes a header line followed by one line per record', () => {
  const store = memoryStore();
  const log = createLogger({ scope: 'T', surface: 'unit', store });
  captureConsole(() => { log.info('one'); log.warn('two'); });
  const text = buildLogExport(store.all(), { surface: 'unit' });
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 3);
  const header = JSON.parse(lines[0]);
  assert.equal(header.kind, 'privagent-log-export');
  assert.equal(header.entry_count, 2);
  assert.equal(JSON.parse(lines[1]).message, 'one');
  assert.equal(JSON.parse(lines[2]).level, 'warn');
  assert.ok(text.endsWith('\n'));
});

test('collectLogEntries merges surfaces in time order', async () => {
  const written = {};
  const area = {
    get: async (key) => (key === null ? { ...written } : { [key]: written[key] }),
    set: async (obj) => { Object.assign(written, obj); }
  };
  // Stand in for the service worker's already-persisted buffer. Reading it back
  // is the point: those entries outlive the worker's in-memory ring, so a
  // worker suspension must not cost us the log. The two timestamps straddle
  // "now" so the panel's own record genuinely interleaves.
  const base = Date.now() - 5000;
  written['privagent_logs:background'] = [
    { ts: '', epoch_ms: base, seq: 1, level: 'info', surface: 'background', message: 'worker before', fields: null, context: null, error: null },
    { ts: '', epoch_ms: base + 10000, seq: 2, level: 'warn', surface: 'background', message: 'worker after', fields: null, context: null, error: null }
  ];
  const store = new LogStore({ storageKey: 'privagent_logs:sidepanel', storage: area });
  const log = createLogger({ scope: 'T', surface: 'sidepanel', store });
  captureConsole(() => { log.info('from panel'); });
  await store.flush();

  // The reader resolves chrome.storage lazily, so the stub has to be global.
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { storage: { local: area } };
  let entries;
  try {
    entries = await collectLogEntries({ stores: [store] });
  } finally {
    globalThis.chrome = previousChrome;
  }

  const messages = entries.map((e) => e.message);
  assert.ok(messages.includes('worker before'));
  assert.ok(messages.includes('worker after'));
  assert.ok(messages.includes('from panel'));
  const times = entries.map((e) => e.epoch_ms);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'entries must be time-ordered');
  // Genuinely interleaved, not grouped by surface: the two contexts have
  // independent sequence counters, so only the timestamp can order them.
  assert.deepEqual(messages, ['worker before', 'from panel', 'worker after']);
});

test('collectLogEntries still exports when storage is unreadable', async () => {
  const area = { get: async () => { throw new Error('gone'); }, set: async () => {} };
  const store = new LogStore({ storageKey: 'privagent_logs:sidepanel', storage: area });
  const log = createLogger({ scope: 'T', surface: 'sidepanel', store });
  captureConsole(() => { log.warn('in memory only'); });
  const entries = await collectLogEntries({ stores: [store] });
  assert.ok(entries.some((e) => e.message === 'in memory only'));
});

// ── Global error handlers ─────────────────────────────────────────────────

test('installGlobalErrorHandlers captures uncaught errors and rejections', () => {
  const store = memoryStore();
  const log = createLogger({ scope: 'global', surface: 'unit', store });
  const target = {
    handlers: new Map(),
    addEventListener(type, fn) {
      if (!this.handlers.has(type)) this.handlers.set(type, []);
      this.handlers.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      this.handlers.set(type, (this.handlers.get(type) || []).filter((f) => f !== fn));
    }
  };
  const uninstall = installGlobalErrorHandlers(log, { target });
  captureConsole(() => {
    target.handlers.get('error')[0]({
      error: new RangeError('kaboom'),
      filename: 'chrome-extension://abc/agent-controller.js', lineno: 42, colno: 7
    });
    target.handlers.get('unhandledrejection')[0]({ reason: new Error('rejected') });
  });

  const entries = store.all();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].level, 'error');
  assert.equal(entries[0].error.name, 'RangeError');
  assert.match(entries[0].fields.source, /agent-controller\.js:42:7/);
  assert.match(entries[1].message, /Unhandled promise rejection/);

  uninstall();
  assert.equal(target.handlers.get('error').length, 0);
  assert.equal(target.handlers.get('unhandledrejection').length, 0);
});

test('a handler that itself throws does not escape', () => {
  const store = memoryStore();
  const log = createLogger({ scope: 'global', surface: 'unit', store });
  const target = {
    handlers: new Map(),
    addEventListener(type, fn) { this.handlers.set(type, [fn]); },
    removeEventListener() {}
  };
  installGlobalErrorHandlers(log, { target });
  // A getter that throws stands in for any fault inside the handler body.
  const hostile = { get error() { throw new Error('hostile event'); } };
  captureConsole(() => {
    assert.doesNotThrow(() => target.handlers.get('error')[0](hostile));
    assert.doesNotThrow(() => target.handlers.get('unhandledrejection')[0](null));
  });
});

test('installGlobalErrorHandlers is a no-op on a target with no listener API', () => {
  assert.doesNotThrow(() => installGlobalErrorHandlers(null, { target: {} }));
  assert.doesNotThrow(() => installGlobalErrorHandlers(null, { target: null }));
});

test('LogLevel is the documented four-level set', () => {
  assert.deepEqual(Object.values(LogLevel).sort(), ['debug', 'error', 'info', 'warn']);
});
