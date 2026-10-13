// Preview server for Codespaces: serves the site and forwards the Firebase
// emulators + local checkout worker through ONE port, so the store can be
// opened from a browser outside the Codespace. Test data only.
//   npm run emulators   (separate terminal)
//   node tests/dev-seed.mjs --catalogue
//   node tests/dev-worker.mjs
//   node tests/preview-server.mjs     -> port 5500
import { createServer, request } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };
const ROUTES = [
  ['/google.firestore.v1.Firestore/', 8085, ''],
  ['/v1/projects/', 8085, ''],
  ['/identitytoolkit.googleapis.com/', 9099, ''],
  ['/securetoken.googleapis.com/', 9099, ''],
  ['/emulator/', 9099, ''],
  ['/api/', 8787, '/api'],
];

function proxy(req, res, port, strip) {
  const path = strip ? req.url.slice(strip.length) || '/' : req.url;
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  const up = request({ host: '127.0.0.1', port, path, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { res.writeHead(502); res.end('backend not running'); });
  req.pipe(up);
}

createServer(async (req, res) => {
  const route = ROUTES.find(([prefix]) => req.url.startsWith(prefix));
  if (route) return proxy(req, res, route[1], route[2]);
  let file = normalize(join(ROOT, decodeURIComponent(req.url.split('?')[0])));
  if (!file.startsWith(ROOT) || file.includes('node_modules') || file.includes('/.git')) { res.writeHead(403); return res.end(); }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(5500, '0.0.0.0', () => console.log('preview on :5500'));
