import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checked = 0;
async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkDirectory(file);
    else if (/\.(c?js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || `无法检查 ${file}`);
      checked += 1;
    }
  }
}
for (const directory of ['src', 'scripts', 'tests']) await checkDirectory(path.join(root, directory));
process.stdout.write(`语法检查通过：${checked} 个 JavaScript 文件。\n`);
