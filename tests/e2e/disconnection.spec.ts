import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('operator socket EPIPE rejects the call without escaping as an uncaught exception or replaying it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-disconnect-'));
  await mkdir(join(root, 'data'));
  const app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...process.env,
      BLUEPRINT_DATA: join(root, 'data'),
      BLUEPRINT_SOCKET: join(root, 'service.sock'),
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole('heading', { name: 'Make decisions before implementation' }),
    ).toBeVisible();
    // An independent client may disappear with responses still queued in the runtime.
    await app.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const { createConnection } = process.getBuiltinModule('net');
          const peer = createConnection(process.env.BLUEPRINT_SOCKET!);
          peer.on('error', reject);
          peer.on('close', () => resolve());
          peer.on('connect', () =>
            peer.write(
              Array.from(
                { length: 50 },
                (_, index) => JSON.stringify({ id: `abort-${index}`, method: 'hello' }) + '\n',
              ).join(''),
              () => peer.destroy(),
            ),
          );
        }),
    );
    await expect(
      page.getByRole('heading', { name: 'Make decisions before implementation' }),
    ).toBeVisible();
    await app.evaluate(async () => {
      const { Socket } = process.getBuiltinModule('net');
      const errors: string[] = [];
      const observation = { errors, writes: 0 };
      Object.assign(globalThis, { blueprintSocketTest: observation });
      // Capture the old failure without opening Electron's native exception dialog.
      process.removeAllListeners('uncaughtException');
      process.on('uncaughtException', (error) => errors.push(error.message));
      const original = Socket.prototype.write;
      Socket.prototype.write = function (
        value: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
      ) {
        let operatorSnapshot = false;
        if (typeof value === 'string') {
          try {
            const request = JSON.parse(value) as { method?: string; params?: { name?: string } };
            operatorSnapshot = request.method === 'operator' && request.params?.name === 'snapshot';
          } catch {
            /* Other sockets can carry inspector frames or arbitrary text. */
          }
        }
        if (operatorSnapshot) {
          observation.writes++;
          Socket.prototype.write = original;
          // Fault at the actual socket boundary after write, before the response arrives.
          queueMicrotask(() =>
            this.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })),
          );
        }
        return original.call(
          this,
          value,
          typeof encodingOrCallback === 'function' ? undefined : encodingOrCallback,
          typeof encodingOrCallback === 'function' ? encodingOrCallback : callback,
        );
      };
    });
    const result = await page.evaluate(async () => {
      const bridge = (
        window as unknown as { blueprint: { invoke: (name: string) => Promise<unknown> } }
      ).blueprint;
      try {
        await bridge.invoke('snapshot');
        return 'resolved';
      } catch (error) {
        return String(error);
      }
    });
    const observation = await app.evaluate(
      () =>
        (globalThis as unknown as { blueprintSocketTest: { errors: string[]; writes: number } })
          .blueprintSocketTest,
    );
    expect(observation.errors).toEqual([]);
    expect(observation.writes).toBe(1);
    expect(result).toContain('UNKNOWN_RESULT');
    expect(await app.evaluate(({ app }) => app.isReady())).toBe(true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
