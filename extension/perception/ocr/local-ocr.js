/**
 * Shared packaged OCR worker for local page perception and local document tools.
 * OCR text is returned only to the caller in the extension page and is never
 * logged or sent to the reasoning backend by this module.
 */

let workerPromise = null;

function extensionApi() {
  return globalThis.browser || globalThis.chrome;
}

export function getPackagedOcrWorker(api = extensionApi()) {
  if (!api?.runtime?.getURL) return Promise.reject(new Error('Extension OCR assets are unavailable.'));
  if (!workerPromise) {
    workerPromise = (async () => {
      const tesseractModule = await import('../../vendor/tesseract/tesseract.esm.min.js');
      const createWorker = tesseractModule.default?.createWorker || tesseractModule.createWorker;
      const base = api.runtime.getURL('vendor/tesseract/');
      return createWorker('eng', 1, {
        workerPath: `${base}worker.min.js`,
        corePath: `${base}tesseract-core-simd-lstm.wasm.js`,
        langPath: api.runtime.getURL('models/lang').replace(/\/$/, ''),
        gzip: true,
        workerBlobURL: false,
        logger: () => {}
      });
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

export async function recognizeLocalPage(image, api = extensionApi()) {
  const worker = await getPackagedOcrWorker(api);
  const result = await worker.recognize(image);
  return result?.data || {};
}

export async function recognizeLocalText(image, api = extensionApi()) {
  const data = await recognizeLocalPage(image, api);
  return typeof data.text === 'string' ? data.text : '';
}
