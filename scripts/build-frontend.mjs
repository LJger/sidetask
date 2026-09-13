import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const directory of ['src', 'assets']) await cp(path.join(root, directory), path.join(output, directory), { recursive: true });
let bytes = 0;
for (const directory of ['src', 'assets']) {
  for (const file of await readdir(path.join(output, directory))) bytes += (await stat(path.join(output, directory, file))).size;
}
console.log(`界面资源已准备：${(bytes / 1024).toFixed(1)} KiB。`);
