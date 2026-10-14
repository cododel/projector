import { URL } from 'node:url';
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, extname, relative } from 'node:path';
import { catalogFingerprint } from '../dev/catalog-source.ts';
const root = await realpath(resolve('.tmp/storybook-static'));
const port = Number(process.argv[2] ?? 6007);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local catalog port');
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.wasm':'application/wasm'};
const server = createServer(async (request,response) => {
  try {
    const url = new URL(request.url,'http://127.0.0.1');
    if (url.pathname === '/catalog-check.log') {
      response.setHeader('Content-Type','text/plain; charset=utf-8'); response.setHeader('Cache-Control','no-store'); response.end(await readFile(resolve('.tmp/catalog/check.log'))); return;
    }
    if (url.pathname === '/catalog-evidence.json') {
      let report = { sourceCurrent: false };
      try { report = JSON.parse(await readFile(resolve(root,'catalog-evidence.json'),'utf8')); } catch { /* Missing report is unverified. */ }
      report.sourceCurrent = report.fingerprint === await catalogFingerprint(resolve('.'));
      response.setHeader('Content-Type','application/json'); response.setHeader('Cache-Control','no-store'); response.end(JSON.stringify(report)); return;
    }
    const path = await realpath(resolve(root,'.'+decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (relative(root,path).startsWith('..')) { response.writeHead(403).end(); return; }
    response.setHeader('Content-Type',mime[extname(path)] ?? 'application/octet-stream'); response.setHeader('Cache-Control','no-store');
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
server.listen(port,'127.0.0.1',() => console.log(`Static catalog: http://127.0.0.1:${port}`));
process.on('SIGTERM',()=>server.close());process.on('SIGINT',()=>server.close());
