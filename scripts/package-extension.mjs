import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!['chrome', 'firefox'].includes(target)) throw new Error('Choose chrome or firefox.');
const source = path.join(root, 'extension');
const destination = path.join(root, 'dist', target);

// Clean stale files from earlier builds before copying: without this, files
// removed from extension/ (e.g. the other browser's manifest, deleted
// modules) silently persist in dist/<target>.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

const manifestName = target === 'firefox' ? 'manifest.firefox.json' : 'manifest.json';
const manifestPath = path.join(destination, manifestName);
const manifest = await readFile(manifestPath, 'utf8');
await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(JSON.parse(manifest), null, 2)}\n`);
if (manifestName !== 'manifest.json') await rm(manifestPath, { force: true });
// The other browser's manifest must never ship inside the build (the chrome
// build previously kept a stray conflicting manifest.firefox.json).
await rm(path.join(destination, 'manifest.firefox.json'), { force: true });

// Test files must never ship in the production build.
for (const file of await listFiles(destination)) {
  if (file.endsWith('.test.js')) await rm(file, { force: true });
}

console.log(`Packaged ${target} extension: ${path.relative(root, destination)}`);

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));
}
