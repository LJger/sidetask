import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const cargo = process.env.CARGO || path.join(process.env.CARGO_HOME || path.join(os.homedir(), '.cargo'), 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const result = spawnSync(cargo, ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--tests'], {
  stdio: 'inherit', env: { ...process.env, TZ: 'Asia/Shanghai' },
});
if (result.error) console.error('请先安装 Rust 工具链：', result.error.message);
process.exitCode = result.status ?? 1;
