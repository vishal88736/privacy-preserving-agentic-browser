import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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

// TheAgenticBrowser reference files require pydantic-ai, which this backend
// deliberately does not install. Keep them as audited reference only: no
// Python source in backend/, tests/, or scripts/ may import `_upstream`.
await assertNoPristineImports();

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

// Syntax check every shipped script. The unit tests import most modules, but
// the side panel and the service worker entry points are only ever loaded by
// the browser, and the browser reports a parse error as a blank panel with a
// single console message. A parse failure that reaches dist/ is a broken
// release, so it is caught here instead.
//
// Content scripts are classic scripts while everything else is an ES module, so
// each file is checked under both grammars: a stray `export` in a content
// script and a stray `import.meta` in a classic script are both load-time
// failures in Chrome.
const JS_EXTENSIONS = new Set(['.js', '.mjs']);
const shippedScripts = shippedFiles.filter((file) => JS_EXTENSIONS.has(path.extname(file)));
const scratch = await mkdtemp(path.join(tmpdir(), 'privagent-parse-'));
const parseFailures = [];
try {
  for (const file of shippedScripts) {
    const relative = path.relative(destination, file);
    const isContentScript = relative.startsWith(`content${path.sep}`);
    for (const asModule of isContentScript ? [true, false] : [true]) {
      const grammar = asModule ? 'esm' : 'classic';
      const checkTarget = path.join(scratch, `check-${grammar}.${asModule ? 'mjs' : 'cjs'}`);
      await writeFile(checkTarget, await readFile(file));
      const result = await run(process.execPath, ['--check', checkTarget]);
      if (result.code !== 0) {
        parseFailures.push(`${relative} (${grammar}): ${result.stderr.split('\n').find((l) => l.includes('Error')) ?? 'parse failed'}`);
      }
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
if (parseFailures.length) {
  throw new Error(`Packaging stopped: ${parseFailures.length} script(s) failed to parse:\n  ${parseFailures.join('\n  ')}`);
}

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

async function assertNoPristineImports() {
  const importPattern = /^[ \t]*(?:from|import)[ \t].*_upstream|import_module.*_upstream|__import__.*_upstream/m;
  const violations = [];
  for (const directory of ['backend', 'tests', 'scripts']) {
    const files = (await listFiles(path.join(root, directory))).filter((file) => file.endsWith('.py'));
    for (const file of files) {
      const contents = await readFile(file, 'utf8');
      if (importPattern.test(contents)) violations.push(path.relative(root, file));
    }
  }
  if (violations.length) {
    throw new Error(`Packaging stopped: Python source imports pristine _upstream reference(s):\n  ${violations.join('\n  ')}`);
  }
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));
}

/** Run a command, capturing output instead of letting it write to the console. */
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
