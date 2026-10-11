import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('background startup and second-instance handling keep the native window hidden without disabling the renderer', async () => {
  test.skip(process.env.BLUEPRINT_E2E_BACKGROUND !== '1', 'Background-mode guarantee only.');
  const root = await mkdtemp(join(tmpdir(), 'bp-background-'));
  const app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...process.env,
      BLUEPRINT_DATA: join(root, 'data'),
      BLUEPRINT_RUNTIME_DESCRIPTOR: join(root, 's.sock'),
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
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          focused: window.isFocused(),
          focusable: window.isFocusable(),
          throttled: window.webContents.getBackgroundThrottling(),
        })),
      ),
    ).toEqual([{ visible: false, focused: false, focusable: false, throttled: false }]);
    const image = await app.evaluate(async ({ BrowserWindow }) => {
      const capture = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
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
