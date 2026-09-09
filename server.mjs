// A zero-dependency static server, so the site can be viewed locally without
// installing anything.
//   npm start            -> http://localhost:8000
//   node server.mjs      -> the same, but serves the directory you are in
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const PORT = Number(process.env.PORT || 8000);
const ROOT = resolve(process.cwd());
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  let path = '/';
  try {
    path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch { /* malformed escape; fall through to 404 */ }
  if (path.endsWith('/')) path += 'index.html';

  const file = resolve(join(ROOT, path));
  // Never serve outside the directory being served, whatever the URL says.
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}).listen(PORT, () => {
  console.log(`serving ${ROOT} on http://localhost:${PORT}`);
});
