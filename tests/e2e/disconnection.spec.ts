import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('operator IPC loss after send rejects without an uncaught exception or replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-disconnect-'));
  await mkdir(join(root, 'data'));
  const probeFile = join(root, 'probe.cjs');
  await writeFile(probeFile, 'process.parentPort.on("message",()=>{});');
  const app = await electron.launch({ args: [resolve('.')], env: {
    ...process.env, PROJECTOR_DATA: join(root, 'data'),
    PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 'endpoint.json'),
  } });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Make decisions before implementation' })).toBeVisible();
    await app.evaluate(({ utilityProcess }, file) => {
      // Reach the native parent IPC prototype without adding a test-only product hook.
      const probe = utilityProcess.fork(file, [], { stdio: 'ignore' });
      const prototype = Object.getPrototypeOf(probe);
      probe.kill();
      const observation = { errors: [] as string[], writes: 0 };
      Object.assign(globalThis, { projectorIpcTest: observation });
      process.on('uncaughtExceptionMonitor', error => observation.errors.push(error.message));
      const original = prototype.postMessage;
      prototype.postMessage = function (value: { type?: string; name?: string }) {
        const result = Reflect.apply(original, this, [value]);
        if (value.type === 'operator' && value.name === 'snapshot') {
          observation.writes++;
          prototype.postMessage = original;
          // The accepted operation's result is now unknown; it must not be replayed.
          throw Object.assign(new Error('Parent IPC closed after send'), { code: 'EPIPE' });
        }
        return result;
      };
    }, probeFile);
    const result = await page.evaluate(async () => {
      const bridge = (window as unknown as { projector: { invoke: (name: string) => Promise<unknown> } }).projector;
      try { await bridge.invoke('snapshot'); return 'resolved'; }
      catch (error) { return String(error); }
    });
    const observation = await app.evaluate(() =>
      (globalThis as unknown as { projectorIpcTest: { errors: string[]; writes: number } }).projectorIpcTest);
    expect(observation.errors).toEqual([]);
    expect(observation.writes).toBe(1);
    expect(result).toContain('UNKNOWN_RESULT');
    expect(await app.evaluate(({ app }) => app.isReady())).toBe(true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
