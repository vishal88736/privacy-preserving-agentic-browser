import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guards the one code path that decides whether the browser screenshot may be
 * transmitted at all.
 *
 * `LocalVisionEngine.analyzeScreenshot()` had NO test. The suite covered only
 * the runtime seam (`PackagedOnnxRuntime` / the inference provider), and
 * `tests/agent/fast-path.test.js` stubs `_analyzeScreenshotLocally` away
 * entirely. So a real defect sat in the uncovered middle: the method read
 * `hasLowConfidenceCoverage` eleven lines ABOVE its `const` declaration. That
 * is a temporal-dead-zone ReferenceError, and because it sat behind a `||`
 * short-circuit it only threw when OCR had successfully located every sensitive
 * span -- the happy path. The throw was caught upstream, logged as a warning,
 * and swallowed, which forced `forceWithhold` and made the remote `/vision`
 * endpoint permanently unreachable. The extension looked fine and did nothing.
 *
 * These tests execute the real method with stubbed inference so that class of
 * ordering bug cannot ship again.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../extension/perception/local-vision.js', import.meta.url)),
  'utf8'
);

/** 1x1 PNG, enough for the createImageBitmap path to be stubbed past. */
const PIXEL_PNG = ('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
  + 'AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');

// The module decodes the data URL through createImageBitmap, which node does
// not provide. Stub just enough of it to reach the real control flow; the
// bitmap's own dimensions are what the method reads.
const IMAGE_WIDTH = 1280;
const IMAGE_HEIGHT = 800;
globalThis.createImageBitmap = async () => ({
  width: IMAGE_WIDTH,
  height: IMAGE_HEIGHT,
  close() {}
});
globalThis.fetch = async () => ({ ok: true, blob: async () => ({}) });

/**
 * Build a LocalVisionEngine whose model + OCR calls are stubbed, so
 * analyzeScreenshot runs its real control flow without needing WASM assets.
 */
function engineWithStubs({ lines = [], people = [], words = [] } = {}) {
  return import('../../extension/perception/local-vision.js').then(({ LocalVisionEngine }) => {
    const engine = new LocalVisionEngine();
    // Detector returns person boxes; OCR returns the given lines/words.
    engine._loadDetector = async () => async () => people;
    // The packaged worker exposes recognize(); the method calls it that way.
    engine._loadOcr = async () => ({
      recognize: async () => ({
        data: { lines, text: lines.map((l) => l.text).join('\n') }, words
      })
    });
    engine._assetBytes = async () => 1234;
    return engine;
  });
}

test('analyzeScreenshot completes on the ordinary path (OCR found everything)', async () => {
  // No sensitive text on screen at all: missingBoxes is false and every word is
  // confidently read. This is the path that used to throw a ReferenceError.
  const engine = await engineWithStubs({
    lines: [{ text: 'Welcome to the dashboard', bbox: { x0: 10, y0: 10, x1: 300, y1: 40 } }],
    words: [{ text: 'Welcome', confidence: 92, bbox: { x0: 10, y0: 10, x1: 90, y1: 30 } }]
  });

  const analysis = await engine.analyzeScreenshot(PIXEL_PNG, { width: IMAGE_WIDTH, height: IMAGE_HEIGHT }, {});

  assert.equal(analysis.completed, true, 'the happy path must complete');
  assert.equal(analysis.unableToLocateSensitiveText, false);
  assert.equal(analysis.safeToTransmitAfterRedaction, true,
    'a clean page must be transmittable, otherwise remote vision is dead');
  assert.equal(typeof analysis.totalMs, 'number');
});

test('analyzeScreenshot completes when OCR returns nothing at all', async () => {
  // The opposite extreme. It must still return a result -- fail-closed on the
  // privacy verdict, but never throw.
  const engine = await engineWithStubs({ lines: [], words: [] });
  const analysis = await engine.analyzeScreenshot(PIXEL_PNG, { width: IMAGE_WIDTH, height: IMAGE_HEIGHT }, {});
  assert.equal(analysis.completed, true);
  assert.equal(analysis.unableToLocateSensitiveText, true,
    'reading nothing must not be reported as safe to transmit');
});

test('analyzeScreenshot completes when a person is detected', async () => {
  const engine = await engineWithStubs({
    lines: [{ text: 'Profile photo and name', bbox: { x0: 0, y0: 0, x1: 200, y1: 200 } }],
    people: [{ score: 0.9, box: { xmin: 5, ymin: 5, xmax: 150, ymax: 190 } }]
  });
  const analysis = await engine.analyzeScreenshot(PIXEL_PNG, { width: IMAGE_WIDTH, height: IMAGE_HEIGHT }, {});
  assert.equal(analysis.completed, true);
  assert.ok(Array.isArray(analysis.people));
});

test('a low-confidence region withholds rather than claiming coverage', async () => {
  // The rule that was added along with the confidence field. It has to be
  // readable before it is referenced -- that ordering is the whole point.
  const engine = await engineWithStubs({
    lines: [{ text: 'Password', bbox: { x0: 10, y0: 10, x1: 120, y1: 34 } }],
    words: [{ text: 'Password', confidence: 20, bbox: { x0: 10, y0: 10, x1: 120, y1: 34 } }]
  });
  const analysis = await engine.analyzeScreenshot(PIXEL_PNG, { width: IMAGE_WIDTH, height: IMAGE_HEIGHT }, {});
  assert.equal(analysis.completed, true, 'it must still complete, not throw');
  assert.equal(analysis.unableToLocateSensitiveText, true,
    'a region the OCR could not read must not be claimed as masked');
  assert.equal(analysis.safeToTransmitAfterRedaction, false);
});

test('no const is read above its declaration inside analyzeScreenshot', () => {
  // A structural backstop for the exact defect class, scoped to the one method
  // that shipped it. Two things matter here and both are easy to get wrong:
  //
  //  1. Comments are stripped first. The prose explaining the original bug
  //     names the very identifiers being checked, and prose is not a use.
  //  2. Only a STANDALONE READ counts. The line
  //         const { regions, unableToLocateSensitiveText: missingBoxes } =
  //           boxesForSpans(...)
  //     contains the identifier as an object KEY (a rename on the way out of
  //     another function) and reads nothing. Matching it would report a false
  //     positive on every correctly written method.
  const start = SOURCE.indexOf('async analyzeScreenshot(');
  const end = SOURCE.indexOf('\n  }\n', start);
  assert.ok(start !== -1 && end !== -1, 'analyzeScreenshot must exist in this module');
  const body = SOURCE.slice(start, end);
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const declarations = [...code.matchAll(/^([ \t]*)const ([A-Za-z_$][\w$]*)\s*=/gm)]
    .map((m) => ({ name: m[2], indent: m[1].length, index: m.index }))
    // Only declarations at the method's own top level can be read by a sibling
    // statement; deeper ones live inside their own block. The method body is
    // indented 4 (IIFE -> class -> method).
    .filter((d) => d.indent <= 4);
  assert.ok(declarations.length > 5,
    `expected several method-level consts, found ${declarations.length}`);

  const offenders = [];
  for (const { name, index } of declarations) {
    // A standalone read: not preceded by `.`, and not an object key (i.e. not
    // followed by `:`), and not the `const NAME =` declaration itself.
    const pattern = new RegExp(`(?<![.\\w$])${name}(?![\\w$])(?![\\s]*:\\s*[a-z_])`, 'g');
    let use = pattern.exec(code);
    while (use !== null) {
      const preceding = code.slice(Math.max(0, use.index - 6), use.index + 1);
      const isDeclaration = /const\s*$/.test(preceding);
      if (!isDeclaration && use.index < index) {
        offenders.push(`${name}@${use.index}<${index}`);
        break;
      }
      use = pattern.exec(code);
    }
  }
  assert.deepEqual(offenders, [],
    `referenced before declaration, a runtime ReferenceError: ${offenders.join(', ')}`);
});
