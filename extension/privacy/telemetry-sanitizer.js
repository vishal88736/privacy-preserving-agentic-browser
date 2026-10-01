/**
 * Privacy-safe copies for UI events and persisted task history.
 *
 * Execution still receives the original locally resolved action. This module is
 * only for diagnostics, side-panel events, and session snapshots, where an LLM
 * thought, inline value, page error, or extracted string must not become a
 * second copy of page data in extension storage or the UI.
 */

import { defaultDOMSanitizer } from './dom-sanitizer.js';

const MAX_DEPTH = 6;
const MAX_KEYS = 80;
const MAX_ITEMS = 100;
const MAX_TEXT = 3500;
const OMIT_KEYS = new Set(['rawElement', 'raw_response', 'bytes']);
const IMAGE_RE = /^data:image\/[^;]+;base64,/i;

function safeString(value, key = '') {
  if (IMAGE_RE.test(value)) return value;
  if (key === 'value_source' || key === 'element_id' || key === 'id' || key === 'action') {
    return value.slice(0, 200);
  }
  if (key === 'url' || key === 'href' || key === 'openedUrl' || key === 'navigatedTo') {
    return defaultDOMSanitizer.sanitizeUrl(value).slice(0, MAX_TEXT);
  }
  const sanitized = defaultDOMSanitizer.sanitizeUserPrompt(value);
  // Telemetry is not an action payload, so ambiguous numeric strings should
  // fail closed too. This catches phone/order/account-shaped values that the
  // shared registry intentionally leaves context-gated for normal browsing.
  return sanitized.replace(/\b\d(?:[\d\s-]{7,}\d)\b/g, '[REDACTED_NUMBER]').slice(0, MAX_TEXT);
}

function sanitize(value, key, depth) {
  if (typeof value === 'string') return safeString(value, key);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[depth-limited]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => sanitize(item, key, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`[${value.length - MAX_ITEMS} more items]`);
    return items;
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_KEYS)) {
      if (OMIT_KEYS.has(childKey)) {
        output[childKey] = '[omitted]';
        continue;
      }
      output[childKey] = sanitize(childValue, childKey, depth + 1);
    }
    if (Object.keys(value).length > MAX_KEYS) output._omitted_keys = Object.keys(value).length - MAX_KEYS;
    return output;
  }
  return String(value).slice(0, MAX_TEXT);
}

export function sanitizeTelemetry(value) {
  return sanitize(value, '', 0);
}

export function sanitizeActionForTelemetry(action) {
  return sanitizeTelemetry(action);
}
