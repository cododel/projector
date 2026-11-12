import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const mac = process.platform === 'darwin';
const windows = process.platform === 'win32';
const directory = resolve(
  'dist/release',
  mac ? 'mac-arm64/Projector.app/Contents' : windows ? 'win-unpacked' : 'linux-unpacked',
);
const resources = join(directory, mac ? 'Resources' : 'resources');
const node = join(resources, 'mcp', windows ? 'node.exe' : 'node');
const electron = join(directory, mac ? 'MacOS/Projector' : windows ? 'Projector.exe' : 'projector');
const app = join(resources, 'app');
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const expectedNode = (await readFile('.node-version', 'utf8')).trim();
const run = (file, args, env = process.env) =>
  execFileSync(file, args, { encoding: 'utf8', timeout: 15_000, env }).trim();

if (run(node, ['--version']) !== `v${expectedNode}`)
  throw new Error('Unexpected bundled Node version.');
run(node, ['--check', join(resources, 'mcp', 'bridge.cjs')]);
if (!windows) await access(join(resources, 'mcp', 'projector-mcp'));
await access(join(app, metadata.main));
await access(join(resources, 'app-update.yml'));
const expected = JSON.stringify({
  version: metadata.devDependencies.electron,
  arch: process.arch,
});
const runtime = run(
  electron,
  [
    '-e',
    `
  const { writeSync } = require('node:fs');
  const { spawn } = require(${JSON.stringify(join(app, 'node_modules', 'node-pty'))});
  const child = spawn(${JSON.stringify(windows ? 'cmd.exe' : '/bin/sh')},
    ${JSON.stringify(windows ? ['/d', '/c', 'echo projector-pty-ok'] : ['-c', 'echo projector-pty-ok'])},
    { env: process.env });
  let output = '';
  child.onData(data => { output += data });
  child.onExit(({ exitCode }) => {
    if (exitCode !== 0 || !output.includes('projector-pty-ok')) process.exit(1);
    writeSync(1, JSON.stringify({ version: process.versions.electron, arch: process.arch }) + '\\n');
    // ConPTY can keep the probe's event loop alive after its child has exited.
    if (process.platform === 'win32') setImmediate(() => process.exit(0));
  });
`,
  ],
  { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
);
if (runtime !== expected) throw new Error(`Unexpected packaged Electron or PTY output: ${runtime}`);
