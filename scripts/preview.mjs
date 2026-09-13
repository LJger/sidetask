import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

const server = http.createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/') { response.writeHead(302, { Location: '/src/index.html' }).end(); return; }
    const file = path.resolve(root, `.${pathname}`);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !['src', 'assets'].includes(relative.split(path.sep)[0])) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (!(await stat(file)).isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).on('error', () => response.destroy()).pipe(response);
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`侧记界面预览：http://127.0.0.1:${port}\n桌面停靠、托盘和全局快捷键请使用 npm start。\n`));
server.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
