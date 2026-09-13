import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

if (process.platform !== 'win32') {
  console.error('请在 Windows 的终端运行此构建脚本，需要 Rust stable MSVC 与 Visual Studio C++ Build Tools。');
  process.exit(1);
}
const portable = process.argv.includes('--portable');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const cli = path.resolve('node_modules/@tauri-apps/cli/tauri.js');
const built = spawnSync(process.execPath, [cli, 'build', '--target', 'x86_64-pc-windows-msvc', '--no-bundle'], { stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
await mkdir('release', { recursive: true });
const target = path.join('src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release');
const outputs = [];
const executable = `SideTask-Portable-${version}-x64.exe`;
await copyFile(path.join(target, 'SideTask.exe'), path.join('release', executable));
outputs.push(executable);
if (!portable) {
  const bundled = spawnSync(process.execPath, [cli, 'bundle', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis'], { stdio: 'inherit' });
  if (bundled.status !== 0) process.exit(bundled.status ?? 1);
  const installers = (await readdir(path.join(target, 'bundle', 'nsis'))).filter(name => name.endsWith('.exe'));
  if (installers.length !== 1) throw new Error('未找到唯一的 NSIS 安装包。');
  const installer = `SideTask-Setup-${version}-x64.exe`;
  await copyFile(path.join(target, 'bundle', 'nsis', installers[0]), path.join('release', installer));
  outputs.push(installer);
}
for (const name of outputs) {
  const file = path.join('release', name);
  const hash = createHash('sha256').update(await readFile(file)).digest('hex');
  await writeFile(file + '.sha256', `${hash}  ${name}\n`);
  console.log(`${name}: ${((await stat(file)).size / 1024 / 1024).toFixed(2)} MiB`);
}
