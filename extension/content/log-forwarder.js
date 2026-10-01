/**
 * Content Script Log Forwarder
 *
 * Loaded as a classic content script ahead of content.js, because
 * content/content.js is a self-contained IIFE with no imports and manifest V3
 * content scripts are not ES modules — it cannot `import` the shared logger.
 * Registering a shim next to it is the only way to give the content world a
 * logger, and the manifest order guarantees it is defined before content.js
 * evaluates.
 *
 * This shim deliberately does NOT reimplement the buffer, redaction, or JSONL
 * formatting from shared/logger.js. Duplicating the privacy logic in a second
 * file is exactly how the two copies drift apart. It forwards to the
 * background, which owns the single store, and also writes to the real console
 * so a content-script failure is still visible in devtools and to the e2e
 * suites that read the page console.
 *
 * Everything here is best-effort: a tab that is closing, a revoked context, or
 * a page that has removed the runtime must not turn logging into a page error.
 */

(() => {
  const SURFACE = 'content';
  // Matches the MAX_BUFFERED_ENTRIES/FLUSH thresholds in shared/logger.js; a
  // page that logs thousands of lines in one tick is throttled, not dropped
  // silently, so the count of suppressed lines is forwarded with the next one.
  const FORWARD_BATCH = 10;
  const FORWARD_INTERVAL_MS = 500;

  const existing = globalThis.__privAgentLog;
  if (existing && existing.__privAgentContentForwarder) return;

  let queue = [];
  let suppressed = 0;
  let timer = null;

  const consoleMethod = { debug: 'debug', info: 'log', warn: 'warn', error: 'error' };

  function writeConsole(level, scope, message, _fields) {
    try {
      const line = `${level.toUpperCase()} [${scope || 'Content'}] ${message}`;
      const fn = globalThis.console?.[consoleMethod[level] || 'log'];
      if (typeof fn === 'function') fn.call(globalThis.console, line);
    } catch {
      // Page may have replaced console with a throwing stub.
    }
  }

  function send(event) {
    try {
      chrome.runtime.sendMessage({ type: 'LOG_EVENT', payload: event }, () => {
        // Reading lastError suppresses Chrome's "unchecked runtime.lastError"
        // console noise when the background worker is asleep or the tab is
        // being torn down. The log is best-effort by design.
        void chrome.runtime.lastError;
      });
    } catch {
      // Extension context invalidated (reload/update) or no receiver.
    }
  }

  function flush() {
    timer = null;
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    // Snapshot the drop count ONCE, then reset the counter. This was declared
    // `const dropped` and still assigned below, which throws a TypeError on the
    // first flush after any event was dropped -- i.e. exactly when the logger
    // is under pressure and most needed to work.
    const droppedEvents = suppressed;
    suppressed = 0;
    for (const event of batch) {
      if (droppedEvents > 0) {
        event.suppressed = (event.suppressed || 0) + droppedEvents;
      }
      send(event);
    }
  }

  function enqueue(event) {
    queue.push(event);
    if (queue.length >= FORWARD_BATCH) {
      flush();
      return;
    }
    if (timer !== null) return;
    try {
      timer = setTimeout(flush, FORWARD_INTERVAL_MS);
    } catch {
      flush();
    }
  }

  /**
   * Coerce a field bag into something structured-cloneable.
   *
   * Errors do not survive sendMessage with a usable stack, so they are
   * flattened here rather than in the background, where the original object is
   * already gone. The background re-applies full redaction either way.
   */
  function normalizeFields(fields) {
    if (!fields) return null;
    const out = {};
    for (const [key, value] of Object.entries(fields).slice(0, 40)) {
      if (value === undefined) continue;
      try {
        if (value instanceof Error) {
          out[key] = { name: String(value.name || 'Error'), message: String(value.message || ''), stack: String(value.stack || '').slice(0, 2000) };
        } else if (Array.isArray(value)) {
          out[key] = value.slice(0, 20).map((v) => (typeof v === 'object' && v !== null ? '[object]' : v));
        } else if (typeof value === 'object' && value !== null) {
          out[key] = JSON.parse(JSON.stringify(value, (_k, v) => (v === undefined ? null : v)));
        } else if (typeof value === 'function') {
          out[key] = '[function]';
        } else {
          out[key] = value;
        }
      } catch {
        out[key] = '[unserializable]';
      }
    }
    return Object.keys(out).length ? out : null;
  }

  function record(level, scope, message, fields) {
    const text = message === undefined || message === null ? '' : String(message);
    writeConsole(level, scope, text, fields);
    if (level === 'debug') return;
    try {
      enqueue({
        level,
        scope: String(scope || 'Content'),
        message: text.slice(0, 2000),
        fields: normalizeFields(fields),
        url: (() => {
          try { return location.origin; } catch { return null; }
        })()
      });
    } catch {
      // Never let diagnostics break the page.
    }
  }

  const log = {
    __privAgentContentForwarder: true,
    debug: (scope, message, fields) => record('debug', scope, message, fields),
    info: (scope, message, fields) => record('info', scope, message, fields),
    warn: (scope, message, fields) => record('warn', scope, message, fields),
    error: (scope, message, fields) => record('error', scope, message, fields),
    surface: SURFACE,
    /**
     * Report a failure that the surrounding code deliberately swallowed.
     * The content script has no access to the shared buffer, so this exists to
     * make the forwarding explicit at call sites rather than implicit.
     */
    exception: (scope, message, error, fields) => record('error', scope, message, { ...(fields || {}), error })
  };

  try {
    Object.defineProperty(globalThis, '__privAgentLog', {
      value: log,
      configurable: true,
      enumerable: false,
      writable: true
    });
  } catch {
    globalThis.__privAgentLog = log;
  }

  // Errors thrown inside the isolated world are otherwise invisible: the page
  // console shows them only while devtools is open, and nothing persists them.
  // Listening with capture on the shared window is what lets an uncaught
  // content-script failure reach the background log.
  //
  // Deliberately NOT forwarding `window.onerror` for the *page's* own errors:
  // those messages quote page content, and this project treats page text as
  // sensitive. The isolated world's errors arrive with a chrome-extension://
  // filename, which is the marker used to tell them apart.
  const CONTENT_FILENAME = /^chrome-extension:\/\/|^moz-extension:\/\//;
  try {
    globalThis.addEventListener('error', (event) => {
      const filename = String(event?.filename || '');
      if (!CONTENT_FILENAME.test(filename)) return;
      record('error', 'Content', 'Uncaught content script error', {
        source: `${filename}:${event?.lineno ?? '?'}:${event?.colno ?? '?'}`,
        error: event?.error ?? event?.message
      });
    }, true);
  } catch {
    // Non-browser evaluation (unit-test harness).
  }
})();
