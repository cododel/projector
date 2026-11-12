import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { e2eWindowOptions } from '../src/main/e2e-window';
import teardown from './e2e/window-audit-teardown';

describe('test window mode', () => {
  test('background windows retain isolation and preload before the inactive show', () => {
    const options = e2eWindowOptions(
      {
        show: true,
        focusable: true,
        width: 900,
        webPreferences: {
          preload: '/test/preload.cjs',
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      },
      true,
    );
    expect(options).toMatchObject({
      show: false,
      focusable: false,
      enableLargerThanScreen: true,
      width: 900,
      webPreferences: {
        preload: '/test/preload.cjs',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
  });

  test('normal and explicitly visible launches retain their original window behavior', () => {
    const options = { show: true, focusable: true, webPreferences: { backgroundThrottling: true } };
    vi.stubEnv('PROJECTOR_E2E_BACKGROUND', undefined);
    try {
      expect(e2eWindowOptions(options)).toBe(options);
      vi.stubEnv('PROJECTOR_E2E_BACKGROUND', '0');
      expect(e2eWindowOptions(options)).toBe(options);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('a recorded native focus violation fails the suite even after the window is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bp-window-audit-'));
    const path = join(root, 'windows.jsonl');
    vi.stubEnv('PROJECTOR_E2E_WINDOW_AUDIT', path);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await writeFile(path, JSON.stringify({ event: 'window-focus', pid: 1, windowId: 2 }) + '\n');
      await expect(teardown()).rejects.toThrow('Background E2E interrupted the desktop');
      await writeFile(
        path,
        [
          { event: 'window-created', pid: 1, windowId: 2 },
          { event: 'window-show', pid: 1, windowId: 2 },
        ].map(entry => JSON.stringify(entry)).join('\n') + '\n',
      );
      await expect(teardown()).resolves.toBeUndefined();
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
