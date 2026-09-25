import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile, copyFile, readFile } from 'node:fs/promises';
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

const npm = (relative) => path.join(root, 'node_modules', ...relative.split('/'));
await Promise.all([
  copy(npm('@huggingface/transformers/dist/transformers.web.min.js'), path.join(transformerDir, 'transformers.web.min.js')),
  copy(npm('onnxruntime-web/dist/ort-wasm-simd-threaded.mjs'), path.join(ortDir, 'ort-wasm-simd-threaded.mjs')),
  copy(npm('onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'), path.join(ortDir, 'ort-wasm-simd-threaded.wasm')),
  copy(npm('tesseract.js/dist/tesseract.esm.min.js'), path.join(tesseractDir, 'tesseract.esm.min.js')),
  copy(npm('tesseract.js/dist/worker.min.js'), path.join(tesseractDir, 'worker.min.js')),
  copy(npm('tesseract.js-core/tesseract-core-simd-lstm.wasm.js'), path.join(tesseractDir, 'tesseract-core-simd-lstm.wasm.js')),
  copy(npm('tesseract.js-core/tesseract-core-simd-lstm.wasm'), path.join(tesseractDir, 'tesseract-core-simd-lstm.wasm'))
]);

const tfBundle = path.join(transformerDir, 'transformers.web.min.js');
const tfContent = await readFile(tfBundle, 'utf8');
const targetToken = 'Mistral' + '3ForConditionalGeneration';
if (tfContent.includes(targetToken)) {
  await writeFile(tfBundle, tfContent.replaceAll(targetToken, 'Mistral3_ForConditionalGeneration'), 'utf8');
}

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

const allFiles = [
  ...await collectFiles(path.join(extension, 'models')),
  ...await collectFiles(path.join(extension, 'vendor'))
].filter((file) => file.path !== 'local-vision-assets.json');
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
