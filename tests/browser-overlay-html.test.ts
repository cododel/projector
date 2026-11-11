import { expect, test } from 'vitest';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

for (const minify of [false,true]) test(`browser overlay geometry executes after ${minify ? 'minified' : 'ordinary'} bundling`, async () => {
  const bundle = await build({ entryPoints:['src/main/browser-overlay-html.ts'], bundle:true, write:false, format:'cjs', platform:'node', loader: { '.css': 'text' }, minify });
  const module = { exports:{} as {browserOverlayHtml?: string} };
  runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports});
  const helpers = module.exports.browserOverlayHtml!.match(/const markerGeometry=[\s\S]*?(?=\nconst \$=)/)![0];
  const position = runInNewContext(`${helpers}; commentPosition({x:90,y:90},{width:640,height:480},{width:200,height:90})`);
  expect(position).toEqual({x:12,y:102});
});
