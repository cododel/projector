import { it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const execute = promisify(execFile);
const require = createRequire(import.meta.url);
it('qualifies PTY ownership and ended-process removal through real Electron utilityProcess IPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-terminal-electron-'));
  const data = join(root, 'data');
  await mkdir(data);
  try {
    const main = join(root, 'main.cjs');
    const service = join(root, 'service.cjs');
    await build({
      entryPoints: ['tests/fixtures/terminal-service.ts'],
      outfile: main,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      logLevel: 'silent',
    });
    await build({
      entryPoints: ['src/terminal/service.ts'],
      outfile: service,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['node-pty'],
      logLevel: 'silent',
    });
    const native = dirname(require.resolve('node-pty/package.json'));
    const target = join(root, 'node_modules', 'node-pty');
    await mkdir(target, { recursive: true });
    for (const file of [
      'lib',
      'package.json',
      'LICENSE',
      `prebuilds/${process.platform}-${process.arch}`,
    ])
      await cp(join(native, file), join(target, file), { recursive: true });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      await execute(require('electron'), [main, data, service], { env, timeout: 20000 });
    } catch (error) {
      const diagnostic = await readFile(join(data, 'result.json'), 'utf8').catch(
        () => 'No fixture result',
      );
      throw new Error(diagnostic, { cause: error });
    }
    const result = JSON.parse(await readFile(join(data, 'result.json'), 'utf8'));
    expect(result).toMatchObject({
      success: true,
      versions: { electron: '44.7.0' },
      restored: [],
    });
    expect(result.screen.content).toContain('INPUT:Привет 🙂 日本語');
    expect(result.configuredScreen).toMatchObject({ truncated: true });
    expect(result.configuredScreen.content).toContain('RESTART_LINE:0399');
    expect(result.configuredScreen.content).not.toContain('RESTART_LINE:0000');
    expect(result.configuredReplay.gap).toBe(true);
    expect(result.freshOutputDisplayed).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 25000);
