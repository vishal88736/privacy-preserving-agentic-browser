import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile, copyFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension');
const revision = 'e2f9c7673f0fa61849efe2b56a0d7774779ebb9d';
const modelDir = path.join(extension, 'models', 'Xenova', 'yolos-tiny');
const onnxDir = path.join(modelDir, 'onnx');
const langDir = path.join(extension, 'models', 'lang');
const transformerDir = path.join(extension, 'vendor', 'transformers');
const ortDir = path.join(extension, 'vendor', 'onnxruntime-web');
const tesseractDir = path.join(extension, 'vendor', 'tesseract');
const mediapipeDir = path.join(extension, 'vendor', 'mediapipe');

async function copy(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function download(url, destination, { optional = false, sha256 = null } = {}) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'PrivAgent-local-model-packager/1.0' } });
  if (optional && response.status === 404) return false;
  if (!response.ok) throw new Error(`Asset download failed (${response.status}): ${new URL(url).pathname}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256 && createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error('The pinned YOLOS model checksum did not match. No asset was written.');
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return true;
}

async function collectFiles(directory, base = directory) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath, base));
    else files.push({ path: path.relative(base, fullPath).replaceAll(path.sep, '/'), bytes: (await stat(fullPath)).size });
  }
  return files;
}

await mkdir(onnxDir, { recursive: true });
await mkdir(langDir, { recursive: true });
await mkdir(transformerDir, { recursive: true });
await mkdir(ortDir, { recursive: true });
await mkdir(tesseractDir, { recursive: true });
await mkdir(mediapipeDir, { recursive: true });

const npm = (relative) => path.join(root, 'node_modules', ...relative.split('/'));
// Only the assets the extension actually loads are staged. ort.all.bundle.min.mjs
// embeds the emscripten factory (its `_3` export) and resolves
// ort-wasm-simd-threaded.jsep.wasm through `new URL(..., import.meta.url)`, so
// that sibling .wasm is fetched and the external ort-wasm-simd-threaded.jsep.mjs
// is never imported: the bundle only reaches for it when its embedded factory
// is missing, or when wasmPaths is set, and model-runtime.js deletes wasmPaths.
// tesseract-core-simd-lstm.wasm is not staged either: the shipped
// tesseract-core-simd-lstm.wasm.js is the SINGLE_FILE build, which carries the
// same 2,857,601-byte core as an embedded base64 payload, and tesseract.js's
// getCore() only importScripts the file named by corePath. Both files were dead
// weight in every install (2.8 MiB + 46 KiB).
await Promise.all([
  copy(npm('@huggingface/transformers/dist/transformers.web.min.js'), path.join(transformerDir, 'transformers.web.min.js')),
  copy(npm('onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm'), path.join(ortDir, 'ort-wasm-simd-threaded.jsep.wasm')),
  copy(npm('onnxruntime-web/dist/ort.all.bundle.min.mjs'), path.join(ortDir, 'ort.all.bundle.min.mjs')),
  copy(npm('tesseract.js/dist/tesseract.esm.min.js'), path.join(tesseractDir, 'tesseract.esm.min.js')),
  copy(npm('tesseract.js/dist/worker.min.js'), path.join(tesseractDir, 'worker.min.js')),
  copy(npm('tesseract.js-core/tesseract-core-simd-lstm.wasm.js'), path.join(tesseractDir, 'tesseract-core-simd-lstm.wasm.js')),
  copy(npm('@mediapipe/tasks-vision/vision_bundle.mjs'), path.join(mediapipeDir, 'vision_bundle.mjs')),
  copy(npm('@mediapipe/tasks-vision/wasm/vision_wasm_internal.js'), path.join(mediapipeDir, 'vision_wasm_internal.js')),
  copy(npm('@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm'), path.join(mediapipeDir, 'vision_wasm_internal.wasm'))
]);

// Older builds staged these two before the manifest above was narrowed. Drop
// them from the source tree too, otherwise `cp` in package-extension.mjs keeps
// shipping whatever is left under extension/vendor/.
for (const stale of [
  path.join(ortDir, 'ort-wasm-simd-threaded.jsep.mjs'),
  path.join(tesseractDir, 'tesseract-core-simd-lstm.wasm')
]) {
  await rm(stale, { force: true });
}

const tfBundle = path.join(transformerDir, 'transformers.web.min.js');
let tfContent = await readFile(tfBundle, 'utf8');
tfContent = tfContent.replaceAll('from"onnxruntime-web/webgpu"', 'from"../onnxruntime-web/ort.all.bundle.min.mjs"');
tfContent = tfContent.replaceAll('from"onnxruntime-common"', 'from"../onnxruntime-web/ort.all.bundle.min.mjs"');
await writeFile(tfBundle, tfContent, 'utf8');

const hf = (file) => `https://huggingface.co/Xenova/yolos-tiny/resolve/${revision}/${file}?download=true`;
for (const filename of ['config.json', 'preprocessor_config.json', 'quantize_config.json']) {
  await download(hf(filename), path.join(modelDir, filename), { optional: filename === 'quantize_config.json' });
}
await download(hf('onnx/model_q4.onnx'), path.join(onnxDir, 'model_q4.onnx'), {
  sha256: 'a3e0b7d8931274aee8af01dc31b35d9c379247bdb7c86eaf222090728c4a894b'
});
await download(
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
  path.join(langDir, 'eng.traineddata.gz')
);
await download(
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
  path.join(extension, 'models', 'mediapipe', 'blaze_face_short_range.tflite')
);

const allFiles = [
  ...await collectFiles(path.join(extension, 'models')),
  ...await collectFiles(path.join(extension, 'vendor'))
].filter((file) => file.path !== 'local-vision-assets.json' && !file.path.startsWith('pdfjs/'));
const manifest = {
  object_detection_model: 'Xenova/yolos-tiny',
  revision,
  quantization: 'q4',
  ocr_language: 'eng',
  runtime_downloads: false,
  total_bytes: allFiles.reduce((total, file) => total + file.bytes, 0),
  files: allFiles
};
await writeFile(path.join(extension, 'models', 'local-vision-assets.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared ${allFiles.length} local vision assets (${(manifest.total_bytes / 1048576).toFixed(1)} MiB).`);
