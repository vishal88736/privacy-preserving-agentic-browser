import test from 'node:test';
import assert from 'node:assert/strict';
import { bootPage, FakeElement } from './harness.mjs';

/**
 * Extraction cost regression guard.
 *
 * The extractor used to call `document.querySelectorAll('*')` on EVERY
 * `queryAllDeep()` invocation, purely to discover shadow hosts — and
 * `getQuestionLabel()` calls `queryAllDeep()` once per interactive element.
 * With the 120-element cap that meant up to 120 whole-document walks per
 * extraction, each materialising every node in the page. On a site like
 * YouTube that is thousands of elements times 120, which is what stalled the
 * renderer and made video playback look broken.
 *
 * These tests count the actual number of document-wide walks so the cost is
 * pinned to a constant rather than to the element count.
 */

/** Wrap the booted document so every '*' query is counted. */
function countDocumentWalks(send) {
  const originalQSA = globalThis.document.querySelectorAll;
  let walks = 0;
  globalThis.document.querySelectorAll = (selector) => {
    if (selector === '*') walks += 1;
    return originalQSA.call(globalThis.document, selector);
  };
  return {
    async extract(prompt = 'fill the form') {
      walks = 0;
      const res = await send('EXTRACT_DOM', { prompt });
      return { walks, res };
    },
    get walks() { return walks; },
    restore() { globalThis.document.querySelectorAll = originalQSA; }
  };
}

function makeInputs(count, { unlabelled = false } = {}) {
  const elements = [];
  for (let i = 0; i < count; i++) {
    const el = new FakeElement('input', { type: 'text', name: unlabelled ? '' : `field_${i}`, id: `f${i}` });
    el.type = 'text';
    if (unlabelled) {
      // No name/id/label of any kind: this is what forces the extractor down
      // the getQuestionLabel() path, which is where the per-element
      // document-wide walk used to happen.
      el.name = '';
      el.id = '';
      el.title = '';
      el.placeholder = '';
    }
    elements.push(el);
  }
  return elements;
}

test('extraction walks the whole document a bounded number of times, not once per element', async () => {
  const page = bootPage({ elements: makeInputs(40, { unlabelled: true }) });
  const counter = countDocumentWalks(page.send);
  try {
    const { walks, res } = await counter.extract();
    assert.equal(res.success, true, 'extraction must still succeed');

    // Measured: 7 document-wide walks before the fix, 1 after. Anything above
    // a small constant means per-element walking is back -- on a real page that
    // is up to 120 walks of the entire document per extraction.
    assert.ok(
      walks <= 3,
      `expected a bounded number of document-wide walks, got ${walks} — per-element walking is back`
    );
  } finally {
    counter.restore();
  }
});

test('the walk count does not grow with the number of form fields', async () => {
  const small = bootPage({ elements: makeInputs(5, { unlabelled: true }) });
  const large = bootPage({ elements: makeInputs(60, { unlabelled: true }) });

  const smallCounter = countDocumentWalks(small.send);
  const largeCounter = countDocumentWalks(large.send);
  try {
    await smallCounter.extract();
    const smallWalks = smallCounter.walks;
    await largeCounter.extract();
    const largeWalks = largeCounter.walks;

    // Before the fix this was linear in the field count. It must now be flat.
    assert.ok(
      largeWalks <= smallWalks + 1,
      `document walks must not scale with element count (5 fields -> ${smallWalks}, 60 fields -> ${largeWalks})`
    );
  } finally {
    smallCounter.restore();
    largeCounter.restore();
  }
});

test('heading lookup still resolves the nearest preceding heading per field', async () => {
  // The performance fix replaced a per-element queryAllDeep + .find() with a
  // cached heading index. Prove the LABEL it produces is unchanged: a bare
  // field with no name/aria/label of its own must still inherit the nearest
  // preceding heading, which is the only thing identifying it on forms that
  // wrap each question in a plain <div>.
  const headingText = 'Employment details';
  const field = new FakeElement('input', { type: 'text' });
  // No name/id/placeholder/label: forces getQuestionLabel() to run.
  field.name = '';
  field.id = '';
  field.title = '';
  field.placeholder = '';
  field.rect = { top: 200, left: 0, width: 120, height: 30, bottom: 230, right: 120 };

  const heading = new FakeElement('h3', { innerText: headingText });
  heading.rect = { top: 10, left: 0, width: 100, height: 20, bottom: 30, right: 100 };

  const page = bootPage({ elements: [field], labelTexts: {} });
  const originalQSA = globalThis.document.querySelectorAll;
  let headingQueries = 0;
  globalThis.document.querySelectorAll = (selector) => {
    if (typeof selector === 'string' && selector.includes('h1') && selector.includes('[role="heading"]')) {
      headingQueries += 1;
      return [heading];
    }
    if (selector === '*') return [];
    return originalQSA.call(globalThis.document, selector);
  };
  try {
    const res = await page.send('EXTRACT_DOM', { prompt: 'fill employment' });
    assert.equal(res.success, true);
    assert.equal(res.data.elements.length, 1);

    const extracted = res.data.elements[0];
    const identified = [extracted.label, extracted.accessible_name, extracted.fieldset_legend]
      .filter(Boolean).join(' ');
    assert.match(identified, /Employment details/,
      'the nearest preceding heading must still label the field');

    // And the heading index must be built once per extraction, not per element.
    assert.ok(headingQueries <= 2,
      `heading list should be cached per extraction, got ${headingQueries} queries`);
  } finally {
    globalThis.document.querySelectorAll = originalQSA;
  }
});
// ── Navigating clicks must answer before the document can be torn down ──
//
// A previous fix added `await this._waitForFieldSettle(element)` after
// element.click(). A click that navigates commits within milliseconds, which
// destroys the document and every pending timer in it, so the await never
// resolved, sendResponse() never ran, and the background received
// "The message port closed before a response was received". That turned every
// link click, form submit and SPA route change into a phantom failure -- and
// playback could never be certified from a link click, which is why video
// playback looked broken. Navigation-capable clicks must respond synchronously.

/** Boot a page with `elements`, extract, and return the registry id of `pick`. */
async function groundedId(elements, pick) {
  const page = bootPage({ elements });
  const extraction = await page.send('EXTRACT_DOM', {});
  const element = extraction.data.elements.find(pick);
  assert.ok(element, 'the target must be part of the observation');
  return { page, elementId: element.id };
}

test('a click that can navigate answers synchronously instead of awaiting settle', async () => {
  const link = new FakeElement('a', { href: '/watch?v=abc' });
  const { page, elementId } = await groundedId([link], (el) => el.tag === 'a');

  const started = process.hrtime.bigint();
  // The harness attaches the observation context from the EXTRACT_DOM above,
  // which is what the real background does.
  const result = await page.send('EXECUTE_ACTION', {
    action: 'CLICK',
    target: { element_id: elementId }
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(result.success, true, result.error);
  // The scroll-into-view settle (150ms) happens before the click and is
  // required for correctness. What must NOT follow the click is a settle wait:
  // that is what gets cancelled by the navigation and loses the response.
  // A post-click settle would add >=120ms on top of the scroll, so the bound is
  // set just above the scroll alone.
  assert.ok(elapsedMs < 220,
    `answered after ${elapsedMs.toFixed(0)}ms — it is still awaiting a post-click settle that a navigation will cancel`);
});

test('a click on a plain control still settles so the page can react', async () => {
  // The opposite guarantee: a non-navigating click has no reason to answer
  // early, and settling gives frameworks a chance to react before the
  // verifier samples state.
  const toggle = new FakeElement('button', {});
  const { page, elementId } = await groundedId([toggle], (el) => el.tag === 'button');

  // The harness attaches the observation context from the EXTRACT_DOM above,
  // which is what the real background does.
  const result = await page.send('EXECUTE_ACTION', {
    action: 'CLICK',
    target: { element_id: elementId }
  });
  assert.equal(result.success, true, result.error);
  assert.ok(toggle.clickCount >= 1, 'the control must actually have been clicked');
});
