import { build } from 'esbuild';
import { prepareTerminal } from './prepare-terminal.mjs';
await prepareTerminal();
await build({
  entryPoints: ['src/runtime/service.ts'],
  outfile: 'out/runtime/service.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
});
await build({
  entryPoints: ['src/bridge-entry.ts'],
  outfile: 'out/bridge.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
});

await build({
  entryPoints: ['src/runtime/compiler.ts'],
  outfile: 'out/runtime/compiler.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
});

await build({
  entryPoints: ['src/terminal/service.ts'],
  outfile: 'out/terminal/service.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['node-pty'],
  sourcemap: true,
});
