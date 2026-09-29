import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bootPage, FakeElement } from './harness.mjs';

/**
 * Behavioural tests for the CONTENT SCRIPT THE MANIFEST ACTUALLY INJECTS.
 *
 * `extension/manifest.json` registers only `content/content.js`. An earlier
 * suite imported a parallel set of `extension/content/*.js` modules that no
 * manifest ever registered, so it passed while proving nothing about
 * production — and the two implementations had already drifted, with security
 * fixes present only in the copy that never ran.
 *
 * These tests discover elements through a real EXTRACT_DOM pass, then act on
 * the ids the extractor actually assigned.
 */

const CONTENT_SOURCE = readFileSync(
  fileURLToPath(new URL('../../extension/content/content.js', import.meta.url)), 'utf8'
);

/**
 * Extract a `name(...) { ... }` method body by brace matching.
 * `within` scopes the search to one class, because several classes define
 * methods of the same name (e.g. `clear`).
 */
function extractMethod(source, name, within = null) {
  const scope = within ? extractClass(source, within) : source;
  if (!scope) return null;
  const start = scope.search(new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\s*\\([^)]*\\)\\s*\\{`));
  if (start === -1) return null;
  const open = scope.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < scope.length; i++) {
    if (scope[i] === '{') depth++;
    else if (scope[i] === '}') {
      depth--;
      if (depth === 0) return scope.slice(open + 1, i);
    }
  }
  return null;
}

/** Extract a `class Name { ... }` body by brace matching. */
function extractClass(source, name) {
  const start = source.search(new RegExp(`\\bclass\\s+${name}\\s*\\{`));
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

// ── Target resolution ─────────────────────────────────────────────────────

test('a plan for an element the extractor never saw is refused, not guessed', async () => {
  const page = bootPage({ elements: [new FakeElement('input', { name: 'email' })] });
  await page.send('EXTRACT_DOM', {});

  const result = await page.send('EXECUTE_ACTION', {
    action: 'FILL_FORM_PLAN',
    value: { fields: [{ field_id: 'el_404', control_type: 'TEXT', value: 'secret' }] }
  });

  assert.equal(result.success, false);
  assert.match(result.details[0].reason, /not found|page changed/i);
});

test('observation-bound actions fail closed when no observation context is supplied', async () => {
  const button = new FakeElement('button', { innerText: 'Continue' });
  const page = bootPage({ elements: [button] });
  await page.send('EXTRACT_DOM', {});

  const result = await page.send('EXECUTE_ACTION', {
    action: 'CLICK', target: { element_id: 'el_1' }
  }, { attachObservationContext: false });

  assert.equal(result.success, false);
  assert.match(result.error, /page changed after this observation/i);
  assert.equal(button.clickCount, 0);
});

test('an element id from before a new observation is stale even if the id is reused', async () => {
  const button = new FakeElement('button', { innerText: 'Continue' });
  const page = bootPage({ elements: [button] });
  await page.send('EXTRACT_DOM', {});
  const staleContext = { ...page.lastObservationContext };
  await page.send('EXTRACT_DOM', {});

  const result = await page.send('EXECUTE_ACTION', {
    action: 'CLICK', target: { element_id: 'el_1' }, observationContext: staleContext
  });

  assert.equal(result.success, false);
  assert.match(result.error, /page changed after this observation/i);
  assert.equal(button.clickCount, 0);
});

test('a changed mutation revision invalidates an otherwise current element id', async () => {
  const button = new FakeElement('button', { innerText: 'Continue' });
  const page = bootPage({ elements: [button] });
  await page.send('EXTRACT_DOM', {});
  const staleContext = { ...page.lastObservationContext, mutationRevision: page.lastObservationContext.mutationRevision + 1 };

  const result = await page.send('EXECUTE_ACTION', {
    action: 'CLICK', target: { element_id: 'el_1' }, observationContext: staleContext
  });

  assert.equal(result.success, false);
  assert.match(result.error, /page changed after this observation/i);
  assert.equal(button.clickCount, 0);
});

test('a plan refuses a field whose control type changed after observation', async () => {
  // Observed as a text input. By fill time it is a checkbox — a shape that
  // would silently swallow a value meant for something else.
  const input = new FakeElement('input', { type: 'text', name: 'q' });
  const page = bootPage({ elements: [input] });

  const extraction = await page.send('EXTRACT_DOM', {});
  const fieldId = extraction.data.elements[0].id;

  // The page mutates the control underneath the agent.
  input._type = 'checkbox';

  const result = await page.send('EXECUTE_ACTION', {
    action: 'FILL_FORM_PLAN',
    value: { fields: [{ field_id: fieldId, control_type: 'TEXT', value: 'cvv-123' }] }
  });

  assert.equal(result.success, false);
  assert.match(result.details[0].reason, /type changed/i);
  assert.equal(input.value, '', 'no value may be written into a control of a different type');
});

test('a plan fills a control that still matches the observation', async () => {
  const input = new FakeElement('input', { type: 'text', name: 'full_name' });
  const page = bootPage({ elements: [input] });

  const extraction = await page.send('EXTRACT_DOM', {});
  const fieldId = extraction.data.elements[0].id;

  const result = await page.send('EXECUTE_ACTION', {
    action: 'FILL_FORM_PLAN',
    value: { fields: [{ field_id: fieldId, control_type: 'TEXT', value: 'Synthetic User' }] }
  });

  assert.equal(result.success, true);
  assert.equal(input.value, 'Synthetic User');
  assert.ok(input.events.includes('input'), 'a framework input event must fire');
  assert.ok(input.events.includes('change'));
});

test('a detached element is never written to', async () => {
  const input = new FakeElement('input', { type: 'text', name: 'aadhaar' });
  const page = bootPage({ elements: [input] });

  const extraction = await page.send('EXTRACT_DOM', {});
  const fieldId = extraction.data.elements[0].id;

  input.isConnected = false; // the page re-rendered and dropped the node

  const result = await page.send('EXECUTE_ACTION', {
    action: 'FILL_FORM_PLAN',
    value: { fields: [{ field_id: fieldId, control_type: 'TEXT', value: '1234 5678 9012' }] }
  });

  assert.equal(result.success, false);
  assert.equal(input.value, '');
});

// ── Write verification ────────────────────────────────────────────────────

test('TYPE reports failure when the value exceeds maxlength', async () => {
  const otp = new FakeElement('input', { type: 'text', name: 'otp', maxLength: 6 });
  const page = bootPage({ elements: [otp] });

  const extraction = await page.send('EXTRACT_DOM', {});
  const fieldId = extraction.data.elements[0].id;

  const result = await page.send('EXECUTE_ACTION', {
    action: 'TYPE', target: { element_id: fieldId }, resolvedValue: 'x'.repeat(20)
  });

  // The native value setter does not enforce maxlength, so this used to be
  // reported as a successful write of a 20-character OTP.
  assert.equal(result.success, false);
  assert.match(result.error, /at most 6/);
});

test('SELECT with an empty value selects nothing', async () => {
  const country = new FakeElement('select', {
    name: 'country',
    options: [{ value: '', text: 'Choose…' }, { value: 'in', text: 'India' }, { value: 'us', text: 'United States' }]
  });
  const page = bootPage({ elements: [country] });

  const extraction = await page.send('EXTRACT_DOM', {});
  const fieldId = extraction.data.elements[0].id;

  const result = await page.send('EXECUTE_ACTION', {
    action: 'SELECT', target: { element_id: fieldId }, resolvedValue: ''
  });

  // `text.includes('')` matches every option, so a blank value used to commit
  // option 0 — a real, wrong data write on any country or state dropdown.
  assert.equal(result.success, false);
  assert.equal(country.value, '', 'a blank value must not select the first option');
});

test('SELECT matches a short substring only when unambiguous', async () => {
  const state = new FakeElement('select', {
    name: 'state',
    options: [{ value: 'ny', text: 'New York' }, { value: 'ca', text: 'California' }]
  });
  const page = bootPage({ elements: [state] });

  const extraction = await page.send('EXTRACT_DOM', {});
  const fieldId = extraction.data.elements[0].id;

  const ambiguous = await page.send('EXECUTE_ACTION', {
    action: 'SELECT', target: { element_id: fieldId }, resolvedValue: 'y'
  });
  assert.equal(ambiguous.success, false, 'a one-character match must not select an option');

  const exact = await page.send('EXECUTE_ACTION', {
    action: 'SELECT', target: { element_id: fieldId }, resolvedValue: 'New York'
  });
  assert.equal(exact.success, true);
  assert.equal(state.value, 'ny');
});

// ── Concurrency ───────────────────────────────────────────────────────────

test('an action is refused while an observation is still running', async () => {
  const input = new FakeElement('input', { type: 'text', name: 'email' });
  const page = bootPage({ elements: [input] });

  // An extraction renumbers the registry, so it must never interleave with a
  // plan that is still resolving field ids.
  const extraction = page.send('EXTRACT_DOM', {});
  const action = await page.send('EXECUTE_ACTION', {
    action: 'TYPE', target: { element_id: 'el_1' }, resolvedValue: 'x'
  });

  assert.equal(action.success, false);
  assert.match(action.error, /still running/i);
  await extraction;
});

test('both operations are usable again once the first one settles', async () => {
  const input = new FakeElement('input', { type: 'text', name: 'email' });
  const page = bootPage({ elements: [input] });

  await page.send('EXTRACT_DOM', {});
  const result = await page.send('EXECUTE_ACTION', {
    action: 'TYPE', target: { element_id: 'el_1' }, resolvedValue: 'x'
  });
  assert.equal(result.success, true, 'the guard must release, not wedge the tab');
});

// ── Robustness ────────────────────────────────────────────────────────────

test('a null message does not throw inside the listener', async () => {
  const page = bootPage();
  // The listener used to destructure the message before validating its shape.
  const response = await page.sendRaw(null);
  assert.notEqual(response?.success, true);
});

test('an unknown message type is ignored without error', async () => {
  const page = bootPage();
  const response = await page.sendRaw({ type: 'NOT_A_REAL_TYPE', payload: {} });
  assert.equal(response, undefined);
});

// ── Overlay privacy ───────────────────────────────────────────────────────

test('the overlay renders in a closed shadow root with no queryable id', () => {
  // A page-readable highlight rect told a hostile page exactly what the agent
  // was about to click, and a fixed id was a reliable "extension installed"
  // beacon on every site — both fatal to this product's premise.
  assert.match(CONTENT_SOURCE, /attachShadow\(\{\s*mode:\s*'closed'\s*\}\)/,
    'the overlay must live in a closed shadow root');
  assert.doesNotMatch(CONTENT_SOURCE, /id\s*=\s*['"]privacy-agent-/,
    'the overlay must not expose a queryable id');
  assert.doesNotMatch(CONTENT_SOURCE, /getElementById\(\s*['"]privacy-agent-/,
    'the overlay must not be re-found by id');
  assert.match(extractMethod(CONTENT_SOURCE, 'clear', 'VisualOverlay'), /remove\(\)/,
    'clear() must remove the host rather than only hiding it');
  // The clear path must actually run: the controller sends CLEAR_OVERLAYS
  // fire-and-forget, so a throw here would be invisible.
  assert.doesNotMatch(extractMethod(CONTENT_SOURCE, 'clear', 'VisualOverlay'), /highlightEl\.style\.opacity\s*=\s*'0'/,
    'clear() must not leave a hidden-but-present highlight behind');
});

test('CLEAR_OVERLAYS is acknowledged', async () => {
  const page = bootPage();
  const response = await page.send('CLEAR_OVERLAYS', {});
  assert.equal(response.success, true);
});

// ── Upload guard ──────────────────────────────────────────────────────────

test('a real document upload is refused; the synthetic demo body is the only path', () => {
  const guard = extractMethod(CONTENT_SOURCE, '_executeUpload');
  assert.ok(guard, '_executeUpload must exist in the shipped content script');
  assert.match(guard, /demo\s*!==\s*true/, 'upload must require demo === true');
  assert.match(guard, /content\s*!==\s*['"][^'"]{1,200}['"]/, 'the body must be compared against a fixed literal');
  const names = [...guard.matchAll(/fileName\s*=\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(names, ['synthetic-demo.txt'], 'the uploaded filename must be a constant');
});

// ── Viewport scale ────────────────────────────────────────────────────────

test('the observation reports the device pixel scale', async () => {
  const page = bootPage({ elements: [new FakeElement('input', { name: 'q' })], devicePixelRatio: 2 });
  const extraction = await page.send('EXTRACT_DOM', {});
  // Screenshot-derived coordinates are in device pixels; elementFromPoint wants
  // CSS pixels. Without the scale factor, every vision-derived coordinate on a
  // HiDPI display hit an element twice as far away.
  assert.equal(extraction.data.viewport.scale, 2);
});
