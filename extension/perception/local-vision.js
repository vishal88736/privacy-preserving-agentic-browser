/**
 * Local screenshot analysis. This module is loaded by the extension side panel,
 * never by the server or the page content script. Model, OCR worker, WASM, and
 * language data are served from the packaged extension directory only.
 */

import { findPIIMatches } from '../privacy/pii-rules.js';
import { createLogger } from '../shared/logger.js';
import { PerceptionProvider } from './perception-provider.js';
import { PackagedOnnxRuntime, TransformersOnnxInferenceProvider } from '../runtime/model-runtime.js';
import { getPackagedOcrWorker } from './ocr/local-ocr.js';
import { FaceDetector, FilesetResolver } from '../vendor/mediapipe/vision_bundle.mjs';

const log = createLogger({ scope: 'LocalVision', surface: 'sidepanel' });

const MODEL_ID = 'Xenova/yolos-tiny';
const MODEL_REVISION = 'e2f9c7673f0fa61849efe2b56a0d7774779ebb9d';
const PERSON_THRESHOLD = 0.35;
const LOCAL_VISION_MESSAGE = 'LOCAL_VISION_ANALYZE';
// OCR sanity floor. A real page screenshot always yields a substantial amount
// of text; a screenshot where OCR returns almost nothing is a screenshot whose
// text the OCR simply could not read, which is exactly the case where a
// canvas- or image-rendered secret is sitting in the pixels unmasked.
const MIN_OCR_CHARACTERS = 24;
// OCR confidence floor for a masked region. Tesseract word confidence routinely
// sits in the 0.5-0.8 band for small, anti-aliased or coloured text, so a
// higher floor withheld the screenshot on ordinary pages and silently removed
// all remote vision. 0.45 still catches a region the OCR essentially could not
// read, which is the case that actually matters: we must not claim to have
// masked text we never actually saw.
const MIN_REGION_CONFIDENCE = 0.45;

function extensionApi() {
  return globalThis.browser || globalThis.chrome;
}

// Engine-computed capture-group indices (d flag) give exact span offsets.
// Firefox < 132 lacks hasIndices: fall back to the indexOf approximation.
const HAS_INDICES_FLAG = (() => {
  try { new RegExp('', 'd'); return true; } catch { return false; }
})();

function withIndices(regex) {
  if (!HAS_INDICES_FLAG || regex.flags.includes('d')) return regex;
  try { return new RegExp(regex.source, regex.flags + 'd'); } catch { return regex; }
}

const ACCOUNT_RE = withIndices(/\b(?:account|acct|bank\s*account)(?:\s*(?:number|no\.?|#))?\s*[:#-]?\s*(\d(?:[\s-]?\d){5,23})(?!\d)/gi);
const OTP_RE = withIndices(/\b(?:otp|one[ -]?time(?: password| code)?|verification code|security code|pin)\s*[:#-]?\s*([A-Z0-9-]{4,12})\b/gi);
const CREDENTIAL_RE = withIndices(/\b(?:password|passcode|access token|api key|bearer)\s*[:#-]?\s*([A-Z0-9._~+/-]{6,96}={0,2})/gi);

function asBox(x0, y0, x1, y1, scaleX, scaleY) {
  const left = Math.max(0, x0 * scaleX);
  const top = Math.max(0, y0 * scaleY);
  const right = Math.max(left, x1 * scaleX);
  const bottom = Math.max(top, y1 * scaleY);
  return [left, top, right - left, bottom - top];
}

/** Return sensitive spans only; OCR text itself never leaves this function. */
function sensitiveSpans(text) {
  const spans = [];
  for (const match of findPIIMatches(text, text)) {
    spans.push({ start: match.index, end: match.end, category: match.category });
  }
  const addMatches = (regex, category, predicate = () => true, captureGroup = 0) => {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      if (predicate(match[0], match.index)) {
        const value = captureGroup ? match[captureGroup] : match[0];
        if (!value) continue;
        // Prefer the engine-computed group index when available: indexOf
        // finds the FIRST occurrence of the group inside the full match,
        // which mislocates the span (and mask rectangle) when the value also
        // appears in the matched prefix.
        const groupIndices = captureGroup ? match.indices?.[captureGroup] : null;
        const start = groupIndices
          ? groupIndices[0]
          : match.index + (captureGroup ? match[0].indexOf(value) : 0);
        spans.push({ start, end: start + value.length, category });
      }
    }
  };

  addMatches(ACCOUNT_RE, 'ACCOUNT', () => true, 1);
  addMatches(OTP_RE, 'OTP', () => true, 1);
  addMatches(CREDENTIAL_RE, 'CREDENTIAL', () => true, 1);
  addMatches(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/gi, 'CREDENTIAL');
  addMatches(/\b[A-Z]{4}0[A-Z0-9]{6}\b/gi, 'IFSC');

  // Merge overlaps so one visual area produces one mask.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  return spans.reduce((out, span) => {
    const previous = out[out.length - 1];
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else out.push({ ...span });
    return out;
  }, []);
}

function wordsForLine(line) {
  const words = Array.isArray(line?.words) ? line.words : [];
  let cursor = 0;
  return words.filter((word) => typeof word?.text === 'string' && word.text.trim()).map((word) => {
    const value = word.text.trim();
    const start = cursor;
    const end = start + value.length;
    cursor = end + 1;
    return { word, value, start, end };
  });
}

function lineText(line, indexedWords) {
  return indexedWords.length
    ? indexedWords.map((item) => item.value).join(' ')
    : (typeof line?.text === 'string' ? line.text.trim() : '');
}

function groupWordsByLine(words) {
  const sorted = (words || []).filter((word) => word?.bbox && Number.isFinite(word.bbox.y0) && Number.isFinite(word.bbox.y1))
    .slice().sort((a, b) => ((a.bbox.y0 + a.bbox.y1) / 2) - ((b.bbox.y0 + b.bbox.y1) / 2) || a.bbox.x0 - b.bbox.x0);
  const groups = [];
  for (const word of sorted) {
    const center = (word.bbox.y0 + word.bbox.y1) / 2;
    const height = word.bbox.y1 - word.bbox.y0;
    let group = groups.find((candidate) => Math.abs(candidate.center - center) <= Math.max(8, Math.min(candidate.height, height) * 0.65));
    if (!group) {
      group = { center, height, words: [] };
      groups.push(group);
    }
    group.words.push(word);
  }
  return groups.map((group) => ({ words: group.words.sort((a, b) => a.bbox.x0 - b.bbox.x0) }));
}

function boxesForSpans(lines, imageWidth, imageHeight, viewport) {
  const scaleX = (viewport?.width || imageWidth) / imageWidth;
  const scaleY = (viewport?.height || imageHeight) / imageHeight;
  const regions = [];
  let unableToLocateSensitiveText = false;

  for (const line of lines || []) {
    const indexedWords = wordsForLine(line);
    const text = lineText(line, indexedWords);
    for (const span of sensitiveSpans(text)) {
      const overlapping = indexedWords.filter((item) => item.end > span.start && item.start < span.end);
      const boxes = overlapping.map(({ word }) => word.bbox).filter((bbox) =>
        bbox && Number.isFinite(bbox.x0) && Number.isFinite(bbox.y0) &&
        Number.isFinite(bbox.x1) && Number.isFinite(bbox.y1) && bbox.x1 > bbox.x0 && bbox.y1 > bbox.y0
      );
      if (!boxes.length) {
        unableToLocateSensitiveText = true;
        continue;
      }
      const union = boxes.reduce((box, next) => ({
        x0: Math.min(box.x0, next.x0),
        y0: Math.min(box.y0, next.y0),
        x1: Math.max(box.x1, next.x1),
        y1: Math.max(box.y1, next.y1)
      }), { ...boxes[0] });
      const confidences = overlapping.map(({ word }) => word.confidence).filter(c => Number.isFinite(c));
      const confidence = confidences.length ? confidences.reduce((a, b) => a + b) / confidences.length / 100 : 1.0;
      const b = asBox(union.x0, union.y0, union.x1, union.y1, scaleX, scaleY);
      regions.push({
        box: { x: b[0], y: b[1], width: b[2], height: b[3] },
        textCategory: span.category,
        confidence: Number(confidence.toFixed(2))
      });
    }
  }
  return { regions, unableToLocateSensitiveText };
}

export class LocalVisionEngine extends PerceptionProvider {
  constructor(api = extensionApi(), inferenceProvider = null) {
    super();
    this.api = api;
    this.detectorPromise = null;
    this.backendUsed = null;
    this.ocrPromise = null;
    this.faceDetectorPromise = null;
    this.assetBytesPromise = null;
    this.inferenceProvider = inferenceProvider || new TransformersOnnxInferenceProvider(
      new PackagedOnnxRuntime({ api })
    );
  }

  async _loadDetector() {
    if (this.detectorPromise) return this.detectorPromise;
    this.detectorPromise = this.inferenceProvider.loadModel({
      task: 'object-detection',
      modelId: MODEL_ID,
      revision: MODEL_REVISION,
      dtype: 'q4'
    }).then(() => {
      this.backendUsed = this.inferenceProvider.backendUsed || 'wasm';
      return (input, options) => this.inferenceProvider.infer(input, options);
    }).catch((error) => {
      this.detectorPromise = null;
      this.backendUsed = null;
      log.warn('Packaged local vision model could not initialize.', { error_type: error?.name || 'Error' });
      throw error;
    });
    return this.detectorPromise;
  }

  async _loadOcr() {
    if (!this.ocrPromise) {
      this.ocrPromise = getPackagedOcrWorker(this.api).catch((err) => {
        this.ocrPromise = null;
        throw err;
      });
    }
    return this.ocrPromise;
  }

  async _loadFaceDetector() {
    if (!this.faceDetectorPromise) {
      this.faceDetectorPromise = (async () => {
        const vision = await FilesetResolver.forVisionTasks(
          this.api.runtime.getURL('vendor/mediapipe')
        );
        return FaceDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: this.api.runtime.getURL('models/mediapipe/blaze_face_short_range.tflite'),
            delegate: 'CPU'
          },
          runningMode: 'IMAGE',
          minDetectionConfidence: 0.5
        });
      })().catch(err => {
        this.faceDetectorPromise = null;
        log.warn('Packaged face detector could not initialize.', { error_type: err?.name || 'Error' });
        throw err;
      });
    }
    return this.faceDetectorPromise;
  }

  async _assetBytes() {
    if (!this.assetBytesPromise) {
      this.assetBytesPromise = fetch(this.api.runtime.getURL('models/local-vision-assets.json'))
        .then((response) => response.ok ? response.json() : null)
        .then((manifest) => Number(manifest?.total_bytes) || null)
        .catch(() => null);
    }
    return this.assetBytesPromise;
  }

  async analyzeScreenshot(screenshotDataUrl, viewport = {}, expectedSensitiveCounts = {}) {
    if (!screenshotDataUrl?.startsWith('data:image/')) throw new Error('A captured screenshot is required for local analysis.');
    const startedAt = performance.now();
    const bitmap = await createImageBitmap(await (await fetch(screenshotDataUrl)).blob());
    const imageWidth = bitmap.width;
    const imageHeight = bitmap.height;
    try {
      if (!imageWidth || !imageHeight) throw new Error('The captured screenshot has no readable pixels.');

      const loadStarted = performance.now();
      const [detector, ocr, faceDetector] = await Promise.all([
        this._loadDetector(), 
        this._loadOcr(), 
        this._loadFaceDetector()
      ]);
      const modelLoadMs = performance.now() - loadStarted;

      const detectorStarted = performance.now();
      const [objects, ocrResult, faceResult] = await Promise.all([
        detector(screenshotDataUrl, { threshold: PERSON_THRESHOLD }),
        ocr.recognize(screenshotDataUrl),
        // Mediapipe needs the image bitmap, not the data URL
        faceDetector.detect(bitmap)
      ]);
      const inferenceMs = performance.now() - detectorStarted;

    const scaleX = (viewport?.width || imageWidth) / imageWidth;
    const scaleY = (viewport?.height || imageHeight) / imageHeight;
    const objectDetections = (Array.isArray(objects) ? objects : [])
      .filter((item) => Number(item.score) >= PERSON_THRESHOLD)
      .map((item) => {
        const box = item.box || {};
        return {
          label: String(item.label || 'object').slice(0, 48),
          bbox: asBox(box.xmin, box.ymin, box.xmax, box.ymax, scaleX, scaleY),
          confidence: Number(Number(item.score).toFixed(3))
        };
      })
      .filter((item) => item.bbox.every(Number.isFinite) && item.bbox[2] > 0 && item.bbox[3] > 0);
    
    const faces = (faceResult?.detections || []).map((det) => {
      const box = det.boundingBox;
      return {
        label: 'person',
        bbox: asBox(box.originX, box.originY, box.originX + box.width, box.originY + box.height, scaleX, scaleY),
        confidence: Number(det.categories[0].score.toFixed(3))
      };
    });

    const people = [
      ...objectDetections.filter((item) => item.label.toLowerCase() === 'person'),
      ...faces
    ];

    const ocrLines = ocrResult?.data?.lines || [];
    const { regions: piiRegions, unableToLocateSensitiveText: missingBoxes } = boxesForSpans(
      ocrLines.length ? ocrLines : groupWordsByLine(ocrResult?.data?.words || []),
      imageWidth, imageHeight, viewport
    );
    const ocrText = String(ocrResult?.data?.text || '').replace(/\s+/g, ' ').trim();
    const ocrWordCount = (ocrLines.length ? 0 : (ocrResult?.data?.words || []).length) + ocrText.length;
    // "OCR ran and found nothing" is not evidence that the page holds no
    // sensitive text. A page that renders a card number into a canvas, an SVG
    // <text>, or a background image — and styles it so OCR cannot read it —
    // produces zero spans and zero expected counts (the DOM audit reads
    // innerText, which contains none of those), so the category reconciliation
    // below stays silent and the raw screenshot would be uploaded.
    //
    // The test used is an absolute floor rather than a comparison against the
    // DOM's text volume: OCR reads the whole viewport while the DOM audit reads
    // only main.innerText, so the two are not scope-matched and a ratio check
    // either direction withholds every normal page. A real page always yields
    // far more than MIN_OCR_CHARACTERS of readable text, so the floor catches
    // total OCR defeat without that false-positive risk. Partial OCR defeat on
    // a specific secret is caught by the category reconciliation instead.
    const ocrReadNothing = ocrWordCount < MIN_OCR_CHARACTERS;
    const observedCounts = {};
    for (const region of piiRegions) observedCounts[region.textCategory] = (observedCounts[region.textCategory] || 0) + 1;
    // A region the OCR was not confident about is not a region we can claim to
    // have masked. Before this, confidence was computed per region and then
    // read by nobody, so a half-legible secret counted as covered. Requiring
    // confidence on the masking path is the privacy-correct use of the number.
    //
    // Declared BEFORE unableToLocateSensitiveText, which reads it. With `const`
    // these are in the temporal dead zone until initialised, so reading it
    // first threw a ReferenceError on every step where OCR had located all its
    // spans -- i.e. the happy path. That propagated up as a local-vision
    // failure, which forced the screenshot to be withheld, which made the
    // remote /vision endpoint permanently unreachable. Total, silent failure
    // of both vision paths.
    const lowConfidenceRegions = piiRegions.filter((region) =>
      Number.isFinite(region.confidence) && region.confidence < MIN_REGION_CONFIDENCE);
    const hasLowConfidenceCoverage = lowConfidenceRegions.length > 0;
    const unableToLocateSensitiveText = missingBoxes
      || hasLowConfidenceCoverage
      || (ocrReadNothing && sensitiveSpans(ocrText).length > 0)
      || ocrReadNothing;
    const categoryAliases = { CREDENTIAL: ['CREDENTIAL', 'OTP', 'ACCOUNT'] };
    const uncoveredCategories = Object.entries(expectedSensitiveCounts || {}).flatMap(([category, expected]) => {
      const observed = (categoryAliases[category] || [category]).reduce((sum, name) => sum + (observedCounts[name] || 0), 0);
      return observed < Number(expected) ? [category] : [];
    });
      return {
      completed: true,
      safeToTransmitAfterRedaction: !unableToLocateSensitiveText && uncoveredCategories.length === 0,
      unlocatedSensitiveCategories: uncoveredCategories,
      lowConfidenceRegions: lowConfidenceRegions.map((region) => ({
        category: region.textCategory,
        confidence: region.confidence
      })),
      objectDetections,
      people,
      piiRegions,
      piiCategories: [...new Set(piiRegions.map((region) => region.textCategory))],
      unableToLocateSensitiveText,
      imageWidth,
      imageHeight,
      model: MODEL_ID,
      modelRevision: MODEL_REVISION,
      // Which execution provider actually served this run, so a WebGPU
      // regression is visible in the side panel and the error log instead of
      // showing up only as slower latency.
      backend: this.backendUsed || 'wasm',
      modelLoadMs: Math.round(modelLoadMs),
      inferenceMs: Math.round(inferenceMs),
      totalMs: Math.round(performance.now() - startedAt),
      assetBytes: await this._assetBytes(),
        heapUsedBytes: Number.isFinite(performance.memory?.usedJSHeapSize) ? performance.memory.usedJSHeapSize : null
      };
    } finally {
      bitmap.close?.();
    }
  }
}

export const localVisionEngine = new LocalVisionEngine();

/** Installed in the side-panel page; requests are accepted only from its own background. */
export function setupLocalVisionMessageHandler(api = extensionApi(), engine = localVisionEngine) {
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== LOCAL_VISION_MESSAGE) return false;
    const senderUrl = (() => { try { return new URL(sender?.url || ''); } catch { return null; } })();
    const ownExtensionPage = sender?.id === api.runtime.id && !sender?.tab &&
      (!senderUrl || ['chrome-extension:', 'moz-extension:'].includes(senderUrl.protocol)) &&
      (sender?.frameId === undefined || sender.frameId === 0);
    if (!ownExtensionPage) {
      sendResponse({ success: false, error: 'Local analysis request rejected.' });
      return false;
    }
    engine.analyzeScreenshot(message.payload?.screenshot, message.payload?.viewport, message.payload?.expectedSensitiveCounts)
      .then((analysis) => sendResponse({ success: true, analysis }))
      .catch((error) => sendResponse({ success: false, error: String(error?.message || 'Local visual analysis failed.').slice(0, 1000) }));
    return true;
  });
}
