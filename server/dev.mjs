// 本地预览：在同一端口提供静态文件和选手同步接口，路径与线上一致。生产环境由 nginx 提供静态文件。
import { createReadStream, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PREFIX, createLiveServer } from './live-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4181);
const apiPort = port + 1000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
};

createLiveServer({ dbPath: process.env.LIVE_DB_PATH || resolve(root, '.data/rooms.sqlite') }).listen(apiPort, '127.0.0.1');

createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://dev.invalid');
  if (pathname.startsWith(`${API_PREFIX}/`)) {
    const proxy = request({ host: '127.0.0.1', port: apiPort, method: req.method, path: req.url, headers: req.headers }, (upstream) => {
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    });
    proxy.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(proxy);
    res.on('close', () => proxy.destroy());
    return;
  }
  if (pathname === '/' || pathname === '/lottery') {
    res.writeHead(302, { Location: '/lottery/' });
    res.end();
    return;
  }
  if (!pathname.startsWith('/lottery/')) { res.writeHead(404); res.end(); return; }
  let relative;
  try { relative = decodeURIComponent(pathname.slice('/lottery/'.length)); }
  catch { res.writeHead(400); res.end(); return; }
  if (relative.split(/[\\/]/).some(part => part.startsWith('.'))) { res.writeHead(404); res.end(); return; }
  let file = resolve(join(root, relative));
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    statSync(file);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`preview on http://127.0.0.1:${port}/lottery/`));
