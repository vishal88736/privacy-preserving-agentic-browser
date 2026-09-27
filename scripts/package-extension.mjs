import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!['chrome', 'firefox'].includes(target)) throw new Error('Choose chrome or firefox.');
const source = path.join(root, 'extension');
const destination = path.join(root, 'dist', target);

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifestName = target === 'firefox' ? 'manifest.firefox.json' : 'manifest.json';
const sourceManifestPath = path.join(source, manifestName);
const sourceManifest = JSON.parse(await readFile(sourceManifestPath, 'utf8'));
if (sourceManifest.version !== packageJson.version) {
  throw new Error(`Manifest version ${sourceManifest.version} does not match package version ${packageJson.version}.`);
}

// Clean stale files from earlier builds before copying: without this, files
// removed from extension/ (e.g. the other browser's manifest, deleted
// modules) silently persist in dist/<target>.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

const manifestPath = path.join(destination, manifestName);
await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(sourceManifest, null, 2)}\n`);
if (manifestName !== 'manifest.json') await rm(manifestPath, { force: true });
// The other browser's manifest must never ship inside the build (the chrome
// build previously kept a stray conflicting manifest.firefox.json).
await rm(path.join(destination, 'manifest.firefox.json'), { force: true });

// Test files must never ship in the production build.
for (const file of await listFiles(destination)) {
  if (file.endsWith('.test.js')) await rm(file, { force: true });
}

const shippedFiles = await listFiles(destination);
const shippedManifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
if (shippedManifest.version !== packageJson.version) throw new Error('Packaged manifest version verification failed.');

const secretPatterns = [
  { name: 'provider API key', pattern: /\b(?:sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,})\b/g },
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g }
];
let totalBytes = 0;
for (const file of shippedFiles) {
  const fileInfo = await stat(file);
  totalBytes += fileInfo.size;
  if (fileInfo.size > 10 * 1024 * 1024) continue; // binaries/assets are size-checked, not UTF-8 scanned
  const contents = await readFile(file, 'utf8').catch(() => '');
  for (const { name, pattern } of secretPatterns) {
    if (pattern.test(contents)) throw new Error(`Packaging stopped: ${name} pattern found in ${path.relative(destination, file)}.`);
    pattern.lastIndex = 0;
  }
}
// Size budget. Local perception runs in the extension, so the build carries an
// ONNX runtime, a quantised detector, and a Tesseract OCR core; that floor is
// ~45 MiB and cannot be reduced without giving up on-device perception (which
// is the project's whole privacy premise). 50 MiB leaves a few MiB of headroom
// while still catching the failure this guard exists for: an accidentally
// re-staged runtime asset, which adds ~14 MiB in a single file.
const SIZE_BUDGET_BYTES = 50 * 1024 * 1024;
if (totalBytes > SIZE_BUDGET_BYTES) {
  throw new Error(`Extension build is ${totalBytes} bytes; the ${SIZE_BUDGET_BYTES / 1048576} MiB size budget was exceeded.`);
}

console.log(`Packaged ${target} extension: ${path.relative(root, destination)} (${totalBytes} bytes).`);

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));
}
