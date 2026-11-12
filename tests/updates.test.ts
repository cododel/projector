import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0' },
  dialog: { showMessageBox: vi.fn() },
}));

vi.mock('node:fs', () => ({ existsSync: () => true }));

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    }),
  };
});

test('passes the installed application bundle to the Sparkle helper', async () => {
  const bundle = resolve('Applications', 'Projector.app');
  vi.stubGlobal(
    'process',
    Object.create(process, {
      platform: { value: 'darwin' },
      resourcesPath: { value: join(bundle, 'Contents', 'Resources') },
    }),
  );
  try {
    const { checkForUpdates } = await import('../src/main/updates');
    await checkForUpdates(vi.fn());

    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      join(bundle, 'Contents', 'MacOS', 'projector-update-helper'),
      [bundle, expect.any(String)],
      expect.anything(),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
