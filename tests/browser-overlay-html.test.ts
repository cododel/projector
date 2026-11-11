import { expect, test } from 'vitest';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { browserOverlayHtml } from '../src/main/browser-overlay-html';

for (const minify of [false,true]) test(`browser overlay geometry executes after ${minify ? 'minified' : 'ordinary'} bundling`, async () => {
  const bundle = await build({ entryPoints:['src/main/browser-overlay-html.ts'], bundle:true, write:false, format:'cjs', platform:'node', loader: { '.css': 'text' }, minify });
  const module = { exports:{} as {browserOverlayHtml?: string} };
  runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports});
  const helpers = module.exports.browserOverlayHtml!.match(/const markerGeometry=[\s\S]*?(?=\nconst \$=)/)![0];
  const position = runInNewContext(`${helpers}; commentPosition({x:90,y:90},{width:640,height:480},{width:200,height:90})`);
  expect(position).toEqual({x:12,y:102});
});

test('ignores pointer movement before the capture state arrives', async () => {
  type PointerPosition = Pick<PointerEvent, 'movementX' | 'movementY' | 'clientX' | 'clientY'>;
  const elements = new Map<string, { onpointermove?: (event: PointerPosition) => Promise<void> }>();
  const document = {
    addEventListener() {},
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    },
  };
  const window = { projectorCapture: { onLoad() {} } };
  const script = browserOverlayHtml.match(/<script nonce="projector-overlay">([\s\S]*?)<\/script>/)![1];
  runInNewContext(script, { document, window });
  await expect(elements.get('layer')!.onpointermove!({
    movementX: 1, movementY: 0, clientX: 20, clientY: 20,
  })).resolves.toBeUndefined();
});
