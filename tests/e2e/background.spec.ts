import { test, expect, electron } from './test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('background startup and second-instance handling show the native window without activating it', async () => {
  test.skip(process.env.PROJECTOR_E2E_BACKGROUND !== '1', 'Background-mode guarantee only.');
  const root = await mkdtemp(join(tmpdir(), 'bp-background-'));
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
        focused: window.isFocused(),
        focusable: window.isFocusable(),
        throttled: window.webContents.getBackgroundThrottling(),
      };
    })).toEqual({ width: 1360, visible: true, alwaysOnTop: true, focused: false, focusable: false, throttled: false });
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
