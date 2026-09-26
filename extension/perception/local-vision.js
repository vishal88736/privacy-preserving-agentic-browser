/**
 * Local screenshot analysis. This module is loaded by the extension side panel,
 * never by the server or the page content script. Model, OCR worker, WASM, and
 * language data are served from the packaged extension directory only.
 */

import { findPIIMatches } from '../privacy/pii-rules.js';

const MODEL_ID = 'Xenova/yolos-tiny';
const MODEL_REVISION = 'e2f9c7673f0fa61849efe2b56a0d7774779ebb9d';
const PERSON_THRESHOLD = 0.35;
const LOCAL_VISION_MESSAGE = 'LOCAL_VISION_ANALYZE';

function extensionApi() {
  return globalThis.browser || globalThis.chrome;
}

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
        const offset = captureGroup ? match[0].indexOf(value) : 0;
        spans.push({ start: match.index + offset, end: match.index + offset + value.length, category });
      }
    }
  };

  addMatches(/\b(?:account|acct|bank\s*account)(?:\s*(?:number|no\.?|#))?\s*[:#-]?\s*(\d(?:[\s-]?\d){5,23})(?!\d)/gi, 'ACCOUNT', () => true, 1);
  addMatches(/\b(?:otp|one[ -]?time(?: password| code)?|verification code|security code|pin)\s*[:#-]?\s*([A-Z0-9-]{4,12})\b/gi, 'OTP', () => true, 1);
  addMatches(/\b(?:password|passcode|access token|api key|bearer)\s*[:#-]?\s*([A-Z0-9._~+/-]{6,96}={0,2})/gi, 'CREDENTIAL', () => true, 1);
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
      regions.push({ bbox: asBox(union.x0, union.y0, union.x1, union.y1, scaleX, scaleY), category: span.category });
    }
  }
  return { regions, unableToLocateSensitiveText };
}

export class LocalVisionEngine {
  constructor(api = extensionApi()) {
    this.api = api;
    this.detectorPromise = null;
    this.ocrPromise = null;
    this.assetBytesPromise = null;
  }

  async _loadDetector() {
    if (!this.detectorPromise) {
      this.detectorPromise = (async () => {
        const { env, pipeline } = await import('../vendor/transformers/transformers.web.min.js');
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        env.localModelPath = this.api.runtime.getURL('models/');
        env.useBrowserCache = false;
        env.backends = env.backends || {};
        env.backends.onnx = env.backends.onnx || {};
        env.backends.onnx.wasm = env.backends.onnx.wasm || {};
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
        // Do not set wasmPaths as a directory string because ort.all.bundle.min.mjs bundles
        // the wasm loader directly and automatically resolves ort-wasm-simd-threaded.jsep.wasm
        // via import.meta.url. Setting a string wasmPaths triggers dynamic import of the external
        // ort-wasm-simd-threaded.jsep.mjs file which fails in extension contexts.
        delete env.backends.onnx.wasm.wasmPaths;
        return pipeline('object-detection', MODEL_ID, {
          device: 'wasm',
          dtype: 'q4',
          revision: MODEL_REVISION,
          progress_callback: () => {}
        });
      })().catch((err) => {
        this.detectorPromise = null;
        throw err;
      });
    }
    return this.detectorPromise;
  }

  async _loadOcr() {
    if (!this.ocrPromise) {
      this.ocrPromise = (async () => {
        const tesseractModule = await import('../vendor/tesseract/tesseract.esm.min.js');
        const createWorker = tesseractModule.default?.createWorker || tesseractModule.createWorker;
        const base = this.api.runtime.getURL('vendor/tesseract/');
        const worker = await createWorker('eng', 1, {
          workerPath: `${base}worker.min.js`,
          corePath: `${base}tesseract-core-simd-lstm.wasm.js`,
          langPath: this.api.runtime.getURL('models/lang').replace(/\/$/, ''),
          gzip: true,
          workerBlobURL: false,
          logger: () => {}
        });
        return worker;
      })().catch((err) => {
        this.ocrPromise = null;
        throw err;
      });
    }
    return this.ocrPromise;
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
      const [detector, ocr] = await Promise.all([this._loadDetector(), this._loadOcr()]);
      const modelLoadMs = performance.now() - loadStarted;

      const detectorStarted = performance.now();
      const [objects, ocrResult] = await Promise.all([
        detector(screenshotDataUrl, { threshold: PERSON_THRESHOLD }),
        ocr.recognize(screenshotDataUrl)
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
    const people = objectDetections.filter((item) => item.label.toLowerCase() === 'person');

    const ocrLines = ocrResult?.data?.lines || [];
    const { regions: piiRegions, unableToLocateSensitiveText: missingBoxes } = boxesForSpans(
      ocrLines.length ? ocrLines : groupWordsByLine(ocrResult?.data?.words || []),
      imageWidth, imageHeight, viewport
    );
    const unableToLocateSensitiveText = missingBoxes ||
      (!(ocrLines.length || ocrResult?.data?.words?.length) && sensitiveSpans(ocrResult?.data?.text || '').length > 0);
    const observedCounts = {};
    for (const region of piiRegions) observedCounts[region.category] = (observedCounts[region.category] || 0) + 1;
    const categoryAliases = { CREDENTIAL: ['CREDENTIAL', 'OTP', 'ACCOUNT'] };
    const uncoveredCategories = Object.entries(expectedSensitiveCounts || {}).flatMap(([category, expected]) => {
      const observed = (categoryAliases[category] || [category]).reduce((sum, name) => sum + (observedCounts[name] || 0), 0);
      return observed < Number(expected) ? [category] : [];
    });
      return {
      completed: true,
      safeToTransmitAfterRedaction: !unableToLocateSensitiveText && uncoveredCategories.length === 0,
      unlocatedSensitiveCategories: uncoveredCategories,
      objectDetections,
      people,
      piiRegions,
      piiCategories: [...new Set(piiRegions.map((region) => region.category))],
      unableToLocateSensitiveText,
      imageWidth,
      imageHeight,
      model: MODEL_ID,
      modelRevision: MODEL_REVISION,
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
