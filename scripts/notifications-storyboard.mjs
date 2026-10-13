import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('.tmp/notifications-storyboard/', root);
await mkdir(output, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('dev/notifications-storyboard.tsx', root))],
  bundle: true, minify: true, format: 'iife',
  outfile: fileURLToPath(new URL('storyboard.js', output)),
  define: { 'process.env.NODE_ENV': '"production"' },
});
const script = await readFile(new URL('storyboard.js', output), 'utf8');
const css = await readFile(new URL('storyboard.css', output), 'utf8');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Projector · Notification storyboard</title><style>${css}</style></head><body><div id="root"></div><script>${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
const page = new URL('index.html', output);
await writeFile(page, html);
console.log(`Notification storyboard: ${fileURLToPath(page)}`);
