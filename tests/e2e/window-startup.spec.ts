import { test, expect, electron } from './test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('startup and second-instance handling use a normal focusable window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-window-'));
  const app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...process.env,
      PROJECTOR_DATA: join(root, 'data'),
      PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 's.sock'),
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole('heading', { name: 'Make decisions before implementation' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'MCP connection', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    // Exercise the real second-instance listener without starting another app or changing user data.
    await app.evaluate(({ app }) => {
      app.emit('second-instance');
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(win => !win.getParentWindow())!;
      return {
        width: window.getBounds().width,
        visible: window.isVisible(),
        alwaysOnTop: window.isAlwaysOnTop(),

        focusable: window.isFocusable(),
        throttled: window.webContents.getBackgroundThrottling(),
      };
    })).toEqual({ width: 1360, visible: true, alwaysOnTop: false, focusable: true, throttled: true });
    const image = await app.evaluate(async ({ BrowserWindow }) => {
      const capture = await BrowserWindow.getAllWindows().find(window => !window.getParentWindow())!.webContents.capturePage();
      return { empty: capture.isEmpty(), size: capture.getSize() };
    });
    expect(image.empty).toBe(false);
    expect(image.size.width).toBeGreaterThan(0);
    expect(image.size.height).toBeGreaterThan(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
