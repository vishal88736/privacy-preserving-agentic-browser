import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!['chrome', 'firefox'].includes(target)) throw new Error('Choose chrome or firefox.');
const source = path.join(root, 'extension');
const destination = path.join(root, 'dist', target);
await mkdir(path.dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });

const manifestName = target === 'firefox' ? 'manifest.firefox.json' : 'manifest.json';
const manifestPath = path.join(destination, manifestName);
const manifest = await readFile(manifestPath, 'utf8');
await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(JSON.parse(manifest), null, 2)}\n`);
if (manifestName !== 'manifest.json') await rm(manifestPath, { force: true });
console.log(`Packaged ${target} extension: ${path.relative(root, destination)}`);
