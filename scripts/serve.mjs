import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
const root = resolve('dist');
const types = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css'};
const server = createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
  const route = pathname === '/' || /^\/local\/?$/.test(pathname) || /^\/plan\/[^/]+\/?$/.test(pathname);
  const file = resolve(root, route ? 'index.html' : '.' + pathname);
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, {'Content-Type':types[extname(file)] || 'application/octet-stream', 'Referrer-Policy':'no-referrer', 'Cache-Control':'no-store'}).end(await readFile(file)); }
  catch { res.writeHead(404).end('Not found'); }
});
const port = Number(process.env.PORT || 4173);
server.listen(port, '127.0.0.1', () => console.log(`CountMeIn: http://127.0.0.1:${port}`));
