/**
 * Structured logging for every extension surface.
 *
 * A Manifest V3 service worker has no filesystem, so "the log file" is a
 * JSONL document built from a bounded ring buffer that is persisted to
 * chrome.storage and exported from the side panel. The backend gets a real
 * rotating file; this is the browser-side equivalent.
 *
 * Three rules shape this module:
 *
 * 1. Logging must never break the agent. Every entry point is wrapped so a
 *    throwing sink, a full storage quota, or a serialization cycle degrades
 *    to a single console line instead of propagating into a caller's
 *    `catch` block and masking the real failure.
 *
 * 2. Nothing sensitive reaches a log. Messages and field values are run
 *    through the extension's own PII redaction (privacy/pii-rules.js) plus
 *    credential scrubbing, and are length-capped. This is deliberate: a raw
 *    exception message can quote page text, and this project already treats
 *    that as a leak risk (see TaskManager.friendlyError).
 *
 * 3. Console output stays human-readable. The e2e suites grep the browser
 *    console for lifecycle markers, and the log file is the machine-readable
 *    artifact, so the two formats are deliberately different.
 */

import { redactPII } from '../privacy/pii-rules.js';

export const LogLevel = Object.freeze({
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error'
});

const LEVEL_RANK = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

/** Schema version, so a later format change stays distinguishable on disk. */
export const LOG_SCHEMA_VERSION = 1;

export const LOG_STORAGE_KEY = 'privagent_logs';

/**
 * Where a log-level override is read from and written to.
 *
 * Every surface reads the same key, so raising the level for a debugging
 * session applies consistently instead of only in the context that happened to
 * read storage first.
 */
export const LOG_LEVEL_STORAGE_KEY = 'privagent_log_level';

/**
 * Storage key for one surface.
 *
 * The service worker and the side panel run in separate JS contexts but share
 * one chrome.storage.local. A single shared key would mean each context
 * overwrites the other's log on every flush, so each surface persists under
 * its own key and the export merges them back together.
 */
export function logStorageKey(surface) {
  const name = String(surface || 'unknown').replace(/[^a-z0-9_-]/gi, '') || 'unknown';
  return `${LOG_STORAGE_KEY}:${name}`;
}


/**
 * Entry cap. chrome.storage.local is quota-limited and the service worker is
 * suspended aggressively, so the log has to be bounded; 500 entries is roughly
 * one long agent task and stays far under the quota even with stack traces.
 */
export const MAX_BUFFERED_ENTRIES = 500;

/** Cap per free-text field, applied after redaction. */
const MAX_TEXT_CHARS = 2000;

/** Cap per stack trace; a minified bundle can produce a very long chain. */
const MAX_STACK_CHARS = 4000;

const FLUSH_DEBOUNCE_MS = 750;
const FLUSH_ENTRY_THRESHOLD = 20;

/**
 * Credential shapes, deliberately overlapping with the packaging guard in
 * scripts/package-extension.mjs so a value that would fail the build can never
 * quietly end up in a log file instead.
 *
 * `keepPrefix` marks a pattern that captures a safe leading fragment (the
 * header name, the assignment target) which is re-emitted ahead of the marker.
 * Patterns without it must use a plain string replacement: a replacer function
 * receives `offset` in the first position when the regex has no capture group,
 * and treating that as text would splice digits into the output.
 */
const CREDENTIAL_PATTERNS = [
  { name: 'api-key', re: /\b(?:sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|hf_[A-Za-z0-9]{8,}|pk-(?:live|test)-[A-Za-z0-9]{8,})\b/g },
  { name: 'bearer-token', re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g },
  { name: 'backend-token', re: /([Xx]-[Pp]riv[Aa]gent-[Tt]oken"?\s*[:=]\s*"?)[^"\s,}]{8,}/g, keepPrefix: true },
  { name: 'assigned-secret', re: /\b((?:api[_-]?key|secret|password|passwd|token|authorization)\s*[:=]\s*)(?!\[REDACTED_)"?[^\s",}]{4,}"?/gi, keepPrefix: true },
  // A screenshot data URL is page content by another name.
  { name: 'data-url', re: /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi }
];

/** Replacement marker, e.g. `api-key` -> `[REDACTED_API_KEY]`. */
function credentialMarker(name) {
  return `[REDACTED_${name.toUpperCase().replace(/-/g, '_')}]`;
}

/** Resolve the active level, tolerating junk in persisted settings. */
export function normalizeLevel(value, fallback = 'info') {
  const candidate = String(value || '').toLowerCase();
  return candidate in LEVEL_RANK ? candidate : fallback;
}

export function levelEnabled(level, threshold) {
  return (LEVEL_RANK[normalizeLevel(level)] ?? 0) >= (LEVEL_RANK[normalizeLevel(threshold)] ?? 0);
}

/**
 * Scrub credentials, then PII, then cap length.
 *
 * Order matters: credential patterns are literal and cheap, so they run first
 * and shorten the string before the more expensive PII scan. Redaction markers
 * themselves contain no digits or PII, so re-running this is idempotent.
 */
export function redactLogText(value) {
  if (value === null || value === undefined) return value;
  let text = String(value);
  for (const { name, re, keepPrefix } of CREDENTIAL_PATTERNS) {
    re.lastIndex = 0;
    const marker = credentialMarker(name);
    // A value that is already a marker must stay a marker: re-running
    // assigned-secret over its own output would otherwise nest one marker
    // inside another on every pass.
    text = keepPrefix
      ? text.replace(re, (_match, prefix) => `${prefix}${marker}`)
      : text.replace(re, marker);
  }
  try {
    text = redactPII(text);
  } catch {
    // Redaction is a safety net, not a correctness requirement: a pattern
    // failure must not suppress the very error being logged.
  }
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…[truncated]` : text;
}

/**
 * Normalize an Error into a plain object.
 *
 * Only name/message/stack are kept. Custom error properties in this codebase
 * carry page-derived detail (OutboundPolicyViolationError.violationDetails
 * quotes the matched value), so they are deliberately dropped.
 */
export function serializeError(error) {
  if (!error) return null;
  if (typeof error === 'string') return { name: 'Error', message: redactLogText(error) };
  if (typeof error !== 'object') return { name: 'Error', message: redactLogText(String(error)) };
  const stack = typeof error.stack === 'string' ? error.stack : '';
  return {
    name: redactLogText(error.name || 'Error'),
    message: redactLogText(error.message || ''),
    stack: stack ? redactLogText(stack.slice(0, MAX_STACK_CHARS)) : undefined
  };
}

/**
 * Convert arbitrary structured field data into JSON-safe, redacted values.
 * Depth and breadth are bounded so a cyclic or huge payload cannot hang the
 * agent loop's logging path.
 */
export function sanitizeFields(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  const type = typeof value;
  if (type === 'string') return redactLogText(value);
  if (type === 'number') return Number.isFinite(value) ? value : String(value);
  if (type === 'boolean') return value;
  if (type === 'bigint') return `${value}n`;
  if (type === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (type === 'symbol') return String(value);
  if (value instanceof Error) return serializeError(value);
  if (depth >= 4) return '[depth-limited]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const capped = value.slice(0, 50).map((item) => sanitizeFields(item, depth + 1, seen));
      if (value.length > 50) capped.push(`[+${value.length - 50} more]`);
      return capped;
    }
    if (value instanceof Map) return sanitizeFields(Object.fromEntries(value), depth + 1, seen);
    if (value instanceof Set) return sanitizeFields([...value], depth + 1, seen);
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) out[key] = sanitizeFields(item, depth + 1, seen);
    return out;
  } catch {
    return '[unserializable]';
  } finally {
    seen.delete(value);
  }
}

/** Human-readable single line, written to the browser console. */
export function formatConsoleLine(entry) {
  const level = String(entry.level || 'info').toUpperCase();
  const scope = entry.scope ? `[${entry.scope}] ` : '';
  let line = `${level} ${scope}${entry.message ?? ''}`;
  if (entry.error) {
    const detail = entry.error.stack || `${entry.error.name}: ${entry.error.message}`;
    line += `\n${detail}`;
  }
  if (entry.fields && Object.keys(entry.fields).length) line += ` ${safeJson(entry.fields)}`;
  if (entry.context && Object.keys(entry.context).length) line += ` ${safeJson(entry.context)}`;
  return line;
}

/** JSON-safe stringification that cannot throw on a cycle. */
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

/** One JSON object per line: the on-disk / export format. */
export function serializeEntry(entry) {
  const line = {
    v: LOG_SCHEMA_VERSION,
    ts: entry.ts,
    epoch_ms: entry.epoch_ms,
    seq: entry.seq,
    level: entry.level,
    surface: entry.surface,
    scope: entry.scope || null,
    message: entry.message,
    fields: entry.fields && Object.keys(entry.fields).length ? entry.fields : null,
    context: entry.context && Object.keys(entry.context).length ? entry.context : null,
    error: entry.error || null
  };
  return safeJson(line);
}

function nowIso() {
  try {
    return new Date().toISOString();
  } catch {
    return '';
  }
}

/**
 * Bounded, persisted ring buffer.
 *
 * Persistence is debounced and serialized through a promise chain: the service
 * worker is suspended without warning, and concurrent unsynchronized
 * read-modify-write cycles against chrome.storage are a classic way to lose
 * entries (and the task snapshot already uses this exact pattern).
 */
export class LogStore {
  constructor({ storageKey = logStorageKey('unknown'), maxEntries = MAX_BUFFERED_ENTRIES, storage } = {}) {
    this.storageKey = storageKey;
    this.maxEntries = maxEntries;
    this.entries = [];
    this.seq = 0;
    this.loaded = false;
    this._flushTimer = null;
    this._flushChain = Promise.resolve();
    this._pending = 0;
    this._storage = storage;
  }

  /** The storage area, resolved lazily: `chrome` may appear after construction. */
  _area() {
    if (this._storage !== undefined) return this._storage;
    try {
      return typeof chrome !== 'undefined' ? chrome.storage?.local ?? null : null;
    } catch {
      return null;
    }
  }

  /** Load previously persisted entries. Safe to call more than once. */
  async hydrate() {
    if (this.loaded) return this.entries;
    this.loaded = true;
    const area = this._area();
    if (!area?.get) return this.entries;
    try {
      const stored = await area.get(this.storageKey);
      const list = stored?.[this.storageKey];
      if (Array.isArray(list)) {
        // Trust only entries that already look like log records; the key is
        // readable by anything with extension storage access.
        this.entries = list.filter((e) => e && typeof e === 'object' && typeof e.message === 'string').slice(-this.maxEntries);
        this.seq = this.entries.reduce((max, e) => (Number.isFinite(e?.seq) && e.seq > max ? e.seq : max), 0);
      }
    } catch {
      // A corrupt or unreadable log must not prevent the agent from starting.
      this.entries = [];
    }
    return this.entries;
  }

  add(entry) {
    this.entries.push(entry);
    // Trim from the front, but keep the sequence counter monotonic.
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    this._scheduleFlush();
    return entry;
  }

  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  all() {
    return this.entries.slice();
  }

  clear() {
    this.entries = [];
    this._flush();
  }

  _scheduleFlush() {
    this._pending += 1;
    if (this._pending >= FLUSH_ENTRY_THRESHOLD) {
      this._flush();
      return;
    }
    if (this._flushTimer !== null) return;
    try {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this._flush();
      }, FLUSH_DEBOUNCE_MS);
    } catch {
      this._flush();
    }
  }

  _flush() {
    if (this._flushTimer !== null) {
      try { clearTimeout(this._flushTimer); } catch { /* already gone */ }
      this._flushTimer = null;
    }
    const area = this._area();
    if (!area?.set) return this._flushChain;
    const snapshot = this.entries.slice(-this.maxEntries);
    this._pending = 0;
    this._flushChain = this._flushChain
      .catch(() => {})
      .then(async () => {
        try {
          await area.set({ [this.storageKey]: snapshot });
        } catch {
          // Quota exhaustion or a revoked storage area: keep logging in memory
          // so the current session stays debuggable.
        }
      });
    return this._flushChain;
  }

  /** Await any scheduled write. Used by tests and by the export path. */
  flush() {
    this._flush();
    return this._flushChain;
  }
}

/**
 * One store per surface, per extension context.
 *
 * Loggers in the same context must share a store, otherwise the in-memory ring
 * buffer and the flush cycle fragment per module and the log file looks empty
 * next to a busy console.
 */
const STORES_BY_SURFACE = new Map();

export function getLogStore(surface = 'unknown', options = {}) {
  if (options.storage !== undefined || options.maxEntries !== undefined) {
    return new LogStore({ ...options, storageKey: options.storageKey ?? logStorageKey(surface) });
  }
  const key = String(surface || 'unknown');
  let store = STORES_BY_SURFACE.get(key);
  if (!store) {
    store = new LogStore({ storageKey: logStorageKey(key) });
    STORES_BY_SURFACE.set(key, store);
  }
  return store;
}

/** All stores in this context, for a cross-surface export. */
export function allLogStores() {
  return [...STORES_BY_SURFACE.values()];
}


/**
 * A scoped logger.
 *
 * Instances are cheap; the surface tag and ambient context are per-context
 * (background / sidepanel / content), while the store is shared.
 */
export class Logger {
  constructor({ scope = 'extension', surface = 'unknown', store, level = 'info' } = {}) {
    this.scope = scope;
    this.surface = surface;
    this.store = store ?? getLogStore(surface);
    this.level = normalizeLevel(level);
    this.context = {};
  }

  /** Derive a logger for a sub-component, inheriting context and level. */
  child(scope) {
    const child = new Logger({
      scope: this.scope ? `${this.scope}.${scope}` : scope,
      surface: this.surface,
      store: this.store,
      level: this.level
    });
    child.context = { ...this.context };
    return child;
  }

  /**
   * Level check, widened to every sibling surface's level.
   *
   * A level recorded by the background must still be emitted when the side
   * panel logs it, otherwise forwarded content diagnostics get filtered out by
   * a threshold that was never applied to them.
   */
  isEnabled(level) {
    return levelEnabled(level, this.level) || allLogStores().some((s) => levelEnabled(level, s.level));
  }

  setLevel(level) {
    this.level = normalizeLevel(level, this.level);
    return this.level;
  }

  /**
   * Attach ambient context (task id, tab id, step) to every subsequent entry.
   * Pass nulls to clear a field; pass nothing to keep the current value.
   */
  setContext(patch) {
    if (!patch) return this.context;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete this.context[key];
      else this.context[key] = value;
    }
    return this.context;
  }

  debug(message, fields) { return this._write(LogLevel.DEBUG, message, fields); }
  info(message, fields) { return this._write(LogLevel.INFO, message, fields); }
  warn(message, fields) { return this._write(LogLevel.WARN, message, fields); }
  error(message, fields) { return this._write(LogLevel.ERROR, message, fields); }

  /**
   * Log an exception. `message` describes what was being attempted, so the
   * record stays useful even when the exception text is fully redacted.
   */
  exception(message, error, fields) {
    return this._write(LogLevel.ERROR, message, { ...(fields || {}), error });
  }

  _write(level, message, fields) {
    try {
      if (!this.isEnabled(level)) return null;
      const { error, ...rest } = fields || {};
      const entry = {
        ts: nowIso(),
        epoch_ms: Date.now(),
        seq: this.store.nextSeq(),
        level,
        surface: this.surface,
        scope: this.scope,
        message: redactLogText(message),
        fields: sanitizeFields(rest),
        context: Object.keys(this.context).length ? sanitizeFields(this.context) : null,
        error: error !== undefined ? serializeError(error) : null
      };
      this.store.add(entry);
      writeConsole(entry);
      return entry;
    } catch (failure) {
      // Last resort: a logging fault must not become the caller's exception.
      try {
        console.error('[Logger] Failed to record entry:', failure);
      } catch { /* console itself is gone */ }
      return null;
    }
  }
}

/**
 * Mirror an entry to the matching console method.
 *
 * A single pre-formatted string is passed rather than a format plus arguments
 * so that overriding console.* (as the tests do) captures the same text a
 * developer would read in devtools.
 */
function writeConsole(entry) {
  const line = formatConsoleLine(entry);
  const method = entry.level === 'debug' ? 'debug' : entry.level === 'warn' ? 'warn' : entry.level === 'error' ? 'error' : 'log';
  try {
    const fn = globalThis.console?.[method] ?? globalThis.console?.log;
    if (typeof fn === 'function') fn.call(globalThis.console, line);
  } catch { /* console is not always callable */ }
}

export function createLogger(options = {}) {
  return new Logger(options);
}

/**
 * Build the JSONL document for the export button: a header line describing
 * the run, then one record per entry.
 */
export function buildLogExport(entries, { surface = 'extension' } = {}) {
  const header = {
    v: LOG_SCHEMA_VERSION,
    kind: 'privagent-log-export',
    exported_at: nowIso(),
    surface,
    entry_count: entries.length,
    version: detectExtensionVersion()
  };
  return [safeJson(header), ...entries.map(serializeEntry)].join('\n') + '\n';
}

/**
 * Gather every persisted entry for export.
 *
 * Reads all `privagent_logs:*` keys rather than only this context's in-memory
 * buffer: the side panel is the exporter, but the interesting failures are in
 * the service worker, whose buffer died with the last suspension. Pending
 * in-memory entries are flushed and overlaid so the newest lines are not lost.
 *
 * Records are ordered by (epoch_ms, seq) so the two contexts interleave
 * correctly in the exported file even though each has an independent counter.
 */
export async function collectLogEntries({ stores } = {}) {
  const merged = new Map();
  const overlay = (list) => {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const key = `${entry.epoch_ms ?? 0}:${entry.seq ?? 0}:${entry.surface ?? ''}`;
      merged.set(key, entry);
    }
  };

  for (const store of stores ?? allLogStores()) {
    try {
      await store.flush();
    } catch { /* storage unavailable; use the in-memory copy below */ }
    overlay(store.all());
  }

  try {
    const area = typeof chrome !== 'undefined' ? chrome.storage?.local : null;
    if (area?.get) {
      const everything = await area.get(null);
      for (const [key, value] of Object.entries(everything || {})) {
        if (key === LOG_STORAGE_KEY || !key.startsWith(`${LOG_STORAGE_KEY}:`)) continue;
        if (Array.isArray(value)) overlay(value);
      }
    }
  } catch {
    // Storage read failed: the in-memory overlay above is still a valid export.
  }

  return [...merged.values()].sort((a, b) =>
    (a.epoch_ms ?? 0) - (b.epoch_ms ?? 0) || (a.seq ?? 0) - (b.seq ?? 0)
  );
}

function detectExtensionVersion() {
  try {
    return globalThis.chrome?.runtime?.getManifest?.()?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Install handlers for otherwise-invisible failures: uncaught exceptions and
 * unhandled promise rejections.
 *
 * Nothing here had coverage before. The agent loop runs detached from its
 * event handler, so a rejection anywhere outside its single explicit catch
 * previously vanished with the suspended worker.
 *
 * Handlers are registered with capture where the target supports it, are
 * idempotent, and swallow their own failures — an exception thrown inside an
 * error handler would otherwise loop.
 */
export function installGlobalErrorHandlers(logger, { target = globalThis, capture = true } = {}) {
  if (!target?.addEventListener) return () => {};
  const log = logger || createLogger({ scope: 'global', surface: 'extension' });

  const onError = (event) => {
    try {
      const error = event?.error ?? event?.message ?? 'Unknown error';
      log.error('Uncaught error', {
        source: event?.filename ? `${event.filename}:${event.lineno ?? '?'}:${event.colno ?? '?'}` : 'unknown-source',
        error
      });
    } catch { /* never rethrow from a handler */ }
  };

  const onRejection = (event) => {
    try {
      log.error('Unhandled promise rejection', { error: event?.reason ?? 'Unknown rejection reason' });
    } catch { /* never rethrow from a handler */ }
  };

  const add = (type, fn) => {
    try {
      target.addEventListener(type, fn, capture);
      return true;
    } catch {
      // Some targets reject the options argument; retry without it before
      // giving up, because a missing handler is exactly the failure this
      // function exists to prevent.
      try {
        target.addEventListener(type, fn);
        return true;
      } catch {
        return false;
      }
    }
  };

  const registered = [];
  for (const [type, fn] of [['error', onError], ['unhandledrejection', onRejection]]) {
    if (add(type, fn)) registered.push([type, fn]);
  }

  return function uninstall() {
    if (!registered.length) return;
    for (const [type, fn] of registered) {
      try { target.removeEventListener(type, fn, capture); } catch { /* ignore */ }
    }
    registered.length = 0;
  };
}
