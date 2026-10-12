import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('a background refresh during a pending sidebar write does not drop the next keyboard resize', async () => {
  const data = await mkdtemp(join(tmpdir(), 'bp-sidebar-sync-'));
  const app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...process.env,
      BLUEPRINT_DATA: data,
      BLUEPRINT_RUNTIME_DESCRIPTOR: join(data, 'runtime.json'),
    },
  });
  try {
    const page = await app.firstWindow();
    const resize = page.getByRole('separator', { name: 'Resize feedback sidebar' });
    await expect(resize).toBeVisible();
    await app.evaluate(async ({ app }) => {
      const fs = process.getBuiltinModule('fs/promises') as typeof import('node:fs/promises');
      const handle = await fs.open(app.getPath('userData'), 'r');
      const prototype = Object.getPrototypeOf(handle),
        sync = prototype.sync;
      await handle.close();
      prototype.sync = async function () {
        prototype.sync = sync;
        await new Promise<void>((resolve) => {
          Object.assign(globalThis, { sidebarWritePaused: true, releaseSidebarWrite: resolve });
        });
        return Reflect.apply(sync, this, []);
      };
    });
    await resize.press('Home');
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { sidebarWritePaused: boolean }).sidebarWritePaused,
        ),
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send('blueprint:refresh'),
    );
    await expect(resize).toHaveAttribute('aria-valuenow', '250');
    await resize.press('ArrowLeft');
    await app.evaluate(() =>
      (globalThis as unknown as { releaseSidebarWrite(): void }).releaseSidebarWrite(),
    );
    await expect(resize).toHaveAttribute('aria-valuenow', '260');
    const layout = await page.evaluate(() =>
      (
        window as unknown as {
          blueprint: { invoke(method: string): Promise<{ layout: { rightSidebarWidth: number } }> };
        }
      ).blueprint.invoke('workspaceSnapshot'),
    );
    expect(layout.layout.rightSidebarWidth).toBe(260);
  } finally {
    await app
      .evaluate(() =>
        (globalThis as unknown as { releaseSidebarWrite?: () => void }).releaseSidebarWrite?.(),
      )
      .catch(() => {});
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
