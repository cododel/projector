import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Mcp } from './mcp';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('a background refresh during a pending sidebar write does not drop the next keyboard resize', async () => {
  const data = await mkdtemp(join(tmpdir(), 'bp-sidebar-sync-'));
  const project = join(data, 'project');
  await mkdir(project);
  let mcp: Mcp | undefined;
  const app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...process.env,
      PROJECTOR_DATA: data,
      PROJECTOR_RUNTIME_DESCRIPTOR: join(data, 'runtime.json'),
    },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, project);
    await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
    mcp = new Mcp(join(data, 'runtime.json'));
    await mcp.initialize();
    const context = await mcp.tool('get_projector_context', {});
    const plan = await mcp.tool('create_artifact', {
      projectId: (context.project as { id: string }).id,
      kind: 'projector',
      title: 'Sidebar sync',
      originSession: { harness: 'codex', sessionId: 'sidebar-test' },
      operationId: randomUUID(),
    });
    await writeFile(join(String(plan.sourcePath), 'plan.mdx'), '# Sidebar sync');
    await mcp.tool('publish_artifact', {
      artifactId: plan.artifactId,
      expectedLatestRevision: null,
      operationId: randomUUID(),
    });
    await page.getByRole('button', { name: 'Sidebar sync', exact: true }).click();
    await expect(
      page.frameLocator('iframe').getByRole('heading', { name: 'Sidebar sync' }),
    ).toBeVisible();
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
      BrowserWindow.getAllWindows()[0].webContents.send('projector:refresh'),
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
          projector: { invoke(method: string): Promise<{ layout: { rightSidebarWidth: number } }> };
        }
      ).projector.invoke('workspaceSnapshot'),
    );
    expect(layout.layout.rightSidebarWidth).toBe(260);
  } finally {
    await app
      .evaluate(() =>
        (globalThis as unknown as { releaseSidebarWrite?: () => void }).releaseSidebarWrite?.(),
      )
      .catch(() => {});
    mcp?.close();
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
