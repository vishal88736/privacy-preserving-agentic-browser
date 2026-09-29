import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Boots the REAL content scripts — the exact files, in the exact order, that
 * `extension/manifest.json` registers — inside a synthetic page, and returns a
 * `send()` that dispatches extension messages to its listener.
 *
 * The manifest lists two files: `log-forwarder.js` then `content.js`. The
 * forwarder has to be evaluated first, in the same global, because content.js
 * reads the `__privAgentLog` it defines. Loading only content.js would prove
 * nothing about the shipped configuration.
 *
 * Both are IIFEs that touch `window`, `document` and `chrome.runtime` at
 * evaluation time, so they cannot simply be imported. This harness supplies
 * just enough of that surface to run them, which means every assertion made
 * through it exercises production code paths.
 *
 * The previous test suite imported a parallel set of `extension/content/*.js`
 * modules that no manifest ever registered. Those tests passed while proving
 * nothing, and the two implementations had already drifted.
 */

const SOURCES = [
  readFileSync(fileURLToPath(new URL('../../extension/content/log-forwarder.js', import.meta.url)), 'utf8'),
  readFileSync(fileURLToPath(new URL('../../extension/content/content.js', import.meta.url)), 'utf8')
];

/** Minimal stand-in for a page element. */
export class FakeElement {
  constructor(tag = 'input', opts = {}) {
    this.tagName = String(tag).toUpperCase();
    this._type = opts.type || 'text';
    this._value = opts.value || '';
    this._options = opts.options || [];
    this.name = opts.name || '';
    this.id = opts.id || '';
    this.placeholder = opts.placeholder || '';
    this.title = opts.title || '';
    this.href = opts.href || '';
    this.role = opts.role || '';
    this.checked = Boolean(opts.checked);
    this.disabled = Boolean(opts.disabled);
    this.required = Boolean(opts.required);
    this.isConnected = opts.isConnected !== false;
    this.maxLength = opts.maxLength ?? -1;
    this.minLength = opts.minLength ?? 0;
    this.pattern = opts.pattern || null;
    this.form = opts.form === null ? null : (opts.form ?? { id: 'form_1' });
    this.files = null;
    this.rect = { left: 0, top: 0, width: 120, height: 30, right: 120, bottom: 30 };
    this.events = [];
    this.clickCount = 0;
    this._listeners = new Map();
    this._innerText = opts.innerText || '';
    this._visible = opts.visible !== false;
  }

  get type() { return this._type; }
  set type(v) { this._type = v; }
  get options() { return this._options; }
  set options(v) { this._options = v; }
  get value() { return this._value; }
  set value(v) { this._value = v; }
  get innerText() { return this._innerText; }
  set innerText(v) { this._innerText = v; }

  getAttribute(name) {
    if (name === 'maxlength') return this.maxLength >= 0 ? String(this.maxLength) : null;
    if (name === 'minlength') return this.minLength > 0 ? String(this.minLength) : null;
    if (name === 'aria-required') return this.required ? 'true' : null;
    return this[name] ?? null;
  }
  getAttributeNames() { return Object.keys(this); }
  getBoundingClientRect() { return this.rect; }
  scrollIntoView() {}
  focus() {}
  click() { this.clickCount++; }
  remove() { this.isConnected = false; }
  setAttribute(name, value) { this[name] = value; }
  get style() { return this._style ||= {}; }
  // The overlay host uses a closed shadow root; the internals stay unreadable
  // from page script, so the stub only has to keep appendChild working.
  attachShadow() {
    const inner = { appendChild() {}, children: [] };
    const host = this;
    return new Proxy(inner, {
      get(target, prop) {
        if (prop === 'appendChild') {
          return (node) => { node._shadowHost = host; target.children.push(node); return node; };
        }
        if (prop === 'children') return target.children;
        return target[prop];
      }
    });
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener() {}
  dispatchEvent(event) {
    this.events.push(event?.type);
    for (const fn of this._listeners.get(event?.type) || []) fn(event);
    return true;
  }
  closest() { return null; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  get labels() { return null; }
  setPointerCapture() {}
}

/**
 * @param {Object} opts
 * @param {FakeElement[]} opts.elements  Elements the extractor should discover.
 * @param {number} opts.devicePixelRatio
 */
export function bootPage({ elements = [], devicePixelRatio = 1, innerWidth = 1280, innerHeight = 800 } = {}) {
  const console_ = globalThis.console;
  const realLog = console_.log;
  const realWarn = console_.warn;
  console_.log = () => {};
  console_.warn = () => {};

  const bySelectorPass = {
    'input, select, textarea, [role="textbox"], [role="checkbox"]':
      elements.filter((el) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)),
    'button, [role="button"], [role="option"]':
      elements.filter((el) => el.tagName === 'BUTTON'),
    'a, [role="link"], [tabindex]:not([tabindex="-1"])':
      elements.filter((el) => el.tagName === 'A')
  };

  class PrototypeStub {}
  globalThis.HTMLInputElement = class extends PrototypeStub {};
  globalThis.HTMLTextAreaElement = class extends PrototypeStub {};
  globalThis.HTMLSelectElement = class extends PrototypeStub {};
  globalThis.Event = class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } };
  globalThis.InputEvent = class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } };
  globalThis.MouseEvent = class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } };
  globalThis.KeyboardEvent = class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } };
  globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
  globalThis.File = class { constructor(parts, name) { this.name = name; this.parts = parts; } };
  globalThis.DataTransfer = class { constructor() { this.items = { add() {} }; this.files = []; } };

  globalThis.window = globalThis;
  globalThis.innerWidth = innerWidth;
  globalThis.innerHeight = innerHeight;
  globalThis.devicePixelRatio = devicePixelRatio;
  globalThis.scrollX = 0;
  globalThis.scrollY = 0;
  globalThis.location = { href: 'https://example.test/', protocol: 'https:', host: 'example.test' };
  globalThis.URL = URL;
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' });
  globalThis.MutationObserver = class { observe() {} disconnect() {} };

  const doc = {
    documentElement: { appendChild() {}, scrollHeight: 2000, style: {} },
    body: { style: {} },
    style: {},
    title: 'Synthetic Test Page',
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === '*' ? [] : (bySelectorPass[selector] || [])),
    createElement: (tag) => new FakeElement(tag),
    addEventListener() {}
  };
  globalThis.document = doc;

  let listener = null;
  globalThis.chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: undefined,
      onMessage: { addListener(fn) { listener = fn; } },
      getURL: (p) => p,
      sendMessage() {}
    },
    tabs: {},
    storage: {}
  };
  globalThis.window.__PRIVACY_AGENT_CONTENT_INITIALIZED__ = false;

  try {
    for (const source of SOURCES) new Function(source)();
  } finally {
    console_.log = realLog;
    console_.warn = realWarn;
  }

  if (typeof listener !== 'function') throw new Error('content script did not register a runtime listener');

  let lastObservationContext = null;
  /** Dispatch an extension message and await the async response. */
  const send = (type, payload = {}, { attachObservationContext = true } = {}) => new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (type === 'EXTRACT_DOM' && value?.success && value.data?.snapshot_id) {
        lastObservationContext = {
          snapshotId: value.data.snapshot_id,
          mutationRevision: value.data.mutation_revision
        };
      }
      resolve(value);
    };
    const actionPayload = type === 'EXECUTE_ACTION' && attachObservationContext &&
      !payload?.observationContext && lastObservationContext
      ? { ...payload, observationContext: lastObservationContext }
      : payload;
    const returned = listener({ type, payload: actionPayload }, { id: 'test-extension-id' }, finish);
    // A synchronous handler answers inline; a `return true` one answers later.
    if (returned !== true) queueMicrotask(() => {});
  });

  /**
   * Dispatch a raw message without waiting for a response.
   *
   * A message the handler ignores (unknown type, untrusted sender) never calls
   * sendResponse at all, so awaiting it would hang. This resolves with whatever
   * the handler produced, or `undefined` when it stayed silent, and reports
   * a thrown error instead of propagating it.
   */
  const sendRaw = (message) => new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let returned;
    try {
      returned = listener(message, { id: 'test-extension-id' }, finish);
    } catch (error) {
      finish({ success: false, error: String(error && error.message) });
      return;
    }
    // `return true` promises an async response; anything else is either a
    // synchronous reply (already resolved above) or a deliberate silence.
    if (returned !== true) setTimeout(() => finish(undefined), 0);
  });

  return { send, sendRaw, elements, devicePixelRatio, FakeElement, get lastObservationContext() { return lastObservationContext; } };
}
