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

test('DOM extraction reports only minimal local playback state for visible media', async () => {
  const video = new FakeElement('video', { paused: false, ended: false, readyState: 4, id: 'private-page-id' });
  const page = bootPage({ elements: [video] });

  const extraction = await page.send('EXTRACT_DOM', {});

  assert.deepEqual(extraction.data.local_media_state, {
    visible_count: 1,
    media: [{ ordinal: 0, tag: 'video', paused: false, ended: false, ready_state: 4 }]
  });
  assert.doesNotMatch(JSON.stringify(extraction.data.local_media_state), /private-page-id/);
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

// ── Upload route ─────────────────────────────────────────────────────────

test('the shipped content script only has the named vault document upload route', () => {
  assert.match(CONTENT_SOURCE, /Choose a named document from the local vault before attaching a file/);
  assert.match(CONTENT_SOURCE, /async _executeVaultDocumentUpload\(/);
  assert.doesNotMatch(CONTENT_SOURCE, /_executeUpload|SYNTHETIC DEMO FILE|synthetic-demo\.txt/);
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

// ── Accessible-name resolution (no site-specific field names) ─────────────

test('aria-labelledby with several ids joins every label part', async () => {
  // W3C: aria-labelledby is a space-separated id list whose texts join in
  // order. Passing the whole string to getElementById returns null, so every
  // field on such a page (Google Forms, ARIA widgets) lost its label and the
  // agent could not tell "Name" from "Phone number".
  const input = new FakeElement('input', { type: 'text', name: 'entry.1234567' });
  input.setAttribute('aria-labelledby', 'i1 i2');
  const page = bootPage({
    elements: [input],
    labelTexts: { i1: 'Name', i2: '(required)' }
  });

  const extraction = await page.send('EXTRACT_DOM', {});
  assert.equal(extraction.data.elements[0].label, 'Name (required)');
});

test('a single aria-labelledby id still resolves', async () => {
  const input = new FakeElement('input', { type: 'text', name: 'q1' });
  input.setAttribute('aria-labelledby', 'only');
  const page = bootPage({ elements: [input], labelTexts: { only: 'Email' } });

  const extraction = await page.send('EXTRACT_DOM', {});
  assert.equal(extraction.data.elements[0].label, 'Email');
});

test('an auto-generated control name is never used as the label', async () => {
  // "entry.2005620554" is not a field name; returning it made every classifier
  // match the wrong thing. Label resolution must fall through instead.
  for (const opaque of ['entry.2005620554', 'question-12', 'field_3', 'input42', 'answer.7']) {
    const input = new FakeElement('input', { type: 'text', name: opaque, placeholder: 'Your answer' });
    const page = bootPage({ elements: [input] });
    const extraction = await page.send('EXTRACT_DOM', {});
    assert.equal(extraction.data.elements[0].label, 'Your answer',
      `opaque name ${opaque} must not be reported as the label`);
  }
});

test('a meaningful control name is still used when nothing better exists', async () => {
  const input = new FakeElement('input', { type: 'text', name: 'household_income' });
  const page = bootPage({ elements: [input] });
  const extraction = await page.send('EXTRACT_DOM', {});
  assert.equal(extraction.data.elements[0].label, 'household_income');
});

test('labels from an aria-labelledby list are read in document order', async () => {
  const input = new FakeElement('input', { type: 'text', name: 'e1' });
  input.setAttribute('aria-labelledby', 'a b c');
  const page = bootPage({ elements: [input], labelTexts: { a: 'Address', b: 'street', c: 'line' } });
  const extraction = await page.send('EXTRACT_DOM', {});
  assert.equal(extraction.data.elements[0].label, 'Address street line');
});

// ── Off-screen form fields (long forms) ───────────────────────────────────

test('a field below the fold is still observed and is typable', async () => {
  // The extractor used to keep only viewport-visible controls, so on a long
  // form the agent saw one screenful, asked the user for values it already
  // had, and could never reach the fields underneath.
  const below = new FakeElement('input', { type: 'text', name: 'entry.9' });
  below.rect = { left: 0, top: 5000, width: 600, height: 40, right: 600, bottom: 5040 };
  const page = bootPage({ elements: [below], innerHeight: 800 });

  const extraction = await page.send('EXTRACT_DOM', {});
  const field = extraction.data.elements.find((el) => el.id === 'el_1');

  assert.ok(field, 'a rendered control below the fold must be observed');
  assert.equal(field.in_viewport, false, 'it must be reported as off-screen');
  assert.equal(field.is_visible, true, 'but it is present and can be typed into');

  const result = await page.send('EXECUTE_ACTION', {
    action: 'TYPE', target: { element_id: field.id }, resolvedValue: 'Pune'
  });
  assert.equal(result.success, true);
  assert.equal(below.value, 'Pune');
});

test('a control that is not rendered at all is still excluded', async () => {
  // The fix must not turn the extractor into "extract everything": a
  // display:none control is not a real field.
  const hidden = new FakeElement('input', { type: 'text', name: 'gone' });
  hidden.rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  const page = bootPage({ elements: [hidden] });
  const extraction = await page.send('EXTRACT_DOM', {});
  assert.equal(extraction.data.elements.length, 0);
});

test('local screenshot coverage is established only when DOM extraction was not truncated', async () => {
  const completePage = bootPage({
    elements: [new FakeElement('input', { name: 'q' })],
    visibleText: 'A complete short page excerpt.'
  });
  const complete = await completePage.send('EXTRACT_DOM', {});
  assert.deepEqual(complete.data.privacy_coverage, {
    established: true,
    interactive_elements_complete: true,
    visible_text_complete: true
  });

  const crowdedPage = bootPage({
    elements: Array.from({ length: 121 }, (_, index) => new FakeElement('input', { name: `field_${index}` }))
  });
  const crowded = await crowdedPage.send('EXTRACT_DOM', {});
  assert.equal(crowded.data.elements.length, 120);
  assert.equal(crowded.data.privacy_coverage.interactive_elements_complete, false);
  assert.equal(crowded.data.privacy_coverage.established, false);

  const longTextPage = bootPage({ visibleText: 'x'.repeat(4001) });
  const longText = await longTextPage.send('EXTRACT_DOM', {});
  assert.equal(longText.data.privacy_coverage.visible_text_complete, false);
  assert.equal(longText.data.privacy_coverage.established, false);
});

// ── Scroll ────────────────────────────────────────────────────────────────

test('SCROLL reports the resulting position instead of faking success', async () => {
  const page = bootPage({ elements: [new FakeElement('input', { name: 'q' })] });
  await page.send('EXTRACT_DOM', {});
  const result = await page.send('EXECUTE_ACTION', { action: 'SCROLL', deltaY: 400 });
  assert.equal(result.success, true, result.error);
  // The planner uses this to know whether more content is reachable; a
  // silent "success" on a page that did not move hides an unreachable form.
  assert.equal(result.moved, true);
  assert.equal(result.scroll.y, 400);
  assert.ok(result.scroll.maxY >= 0);
});

// ── Question-text labels (no field-name hardcoding) ───────────────────────

test('a date input labelled only by its format hint resolves to the question text', async () => {
  // The date question exposed "mm/dd/yyyy" and no aria-labelledby, so the
  // field arrived with no identity at all: no DOB mapping, and the agent
  // asked the user for a date it should have taken from the local vault.
  const input = new FakeElement('input', { type: 'date', name: 'entry.104', placeholder: 'mm/dd/yyyy' });
  input.innerText = '';
  const question = new FakeElement('div', { innerText: 'date of birth' });
  question.getBoundingClientRect = () => ({ left: 0, top: 100, width: 400, height: 24, right: 400, bottom: 124 });
  input.closest = (selector) => (/fieldset|group|radiogroup|listitem|section|article|li/.test(selector) ? question : null);

  const page = bootPage({ elements: [input] });
  const extraction = await page.send('EXTRACT_DOM', {});

  assert.equal(extraction.data.elements[0].label, 'date of birth');
});

test('a generic prompt label is not reported as the field name', async () => {
  const input = new FakeElement('input', { type: 'text', name: 'entry.3', placeholder: 'Your answer' });
  input.innerText = '';
  const page = bootPage({ elements: [input] });
  const extraction = await page.send('EXTRACT_DOM', {});
  // With no question available the placeholder is still the last resort, but a
  // bare type word such as "Date" must never stand in for a field identity.
  assert.ok(['Your answer', ''].includes(extraction.data.elements[0].label),
    `generic prompt leaked as a label: ${extraction.data.elements[0].label}`);
});

test('a filled question block contributes its question, never the typed answer', async () => {
  // Regression: once the agent filled "Name", the question block's innerText is
  // "Name\nvishal". Reading the whole block as the field name put the user's
  // own name into the label — and with no matching vault key there is no local
  // rule that can scrub a bare first name, so it reached the outbound payload
  // and the privacy gate blocked the request.
  const input = new FakeElement('input', { type: 'text', name: 'entry.1' });
  const section = new FakeElement('div', { innerText: 'Name\nvishal' });
  section.getBoundingClientRect = () => ({ left: 0, top: 50, width: 600, height: 120, right: 600, bottom: 170 });
  input.closest = (selector) => (/fieldset|group|radiogroup|listitem|section|article|li/.test(selector) ? section : null);

  const page = bootPage({ elements: [input] });
  const extraction = await page.send('EXTRACT_DOM', {});
  const label = extraction.data.elements[0].label;

  assert.equal(label, 'Name');
  assert.doesNotMatch(label, /vishal/, 'a typed answer must never become the field name');
});

test('a real accessible name still wins over question text', async () => {
  const input = new FakeElement('input', { type: 'text', name: 'entry.1' });
  input.setAttribute('aria-labelledby', 'q1');
  const page = bootPage({ elements: [input], labelTexts: { q1: 'Email address' } });
  const extraction = await page.send('EXTRACT_DOM', {});
  assert.equal(extraction.data.elements[0].label, 'Email address');
});
