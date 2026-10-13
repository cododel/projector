import { test, expect, electron } from './test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

test('Quit continues cleanup after shell contents closes before native window retirement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'projector-dead-shell-'));
  const probe = join(root, 'probe.json');
  const app = await electron.launch({ args: [resolve('.')], env: { ...process.env,
    PROJECTOR_DATA: join(root, 'data'), PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 'runtime.json'),
  } });
  const child = app.process();
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Open project folder', exact: true })).toBeVisible();
    await app.evaluate(({ app, BrowserWindow }, path) => {
      const fs = process.getBuiltinModule('fs') as typeof import('node:fs');
      const parent = BrowserWindow.getAllWindows().find(w => !w.getParentWindow())!;
      const contents = parent.webContents;
      // Real destruction reaches the brief native-window/WebContents lifetime
      // mismatch. Do not mock isDestroyed or the notification send method.
      contents.once('destroyed', () => {
        fs.writeFileSync(path, JSON.stringify({ shellDestroyed: contents.isDestroyed(), windowAlive: !parent.isDestroyed() }));
        app.quit();
      });
      contents.close({ waitForBeforeUnload: false });
    }, probe);
    await expect.poll(() => child.exitCode).toBe(0);
    expect(JSON.parse(await readFile(probe, 'utf8'))).toEqual({ shellDestroyed: true, windowAlive: true });
  } finally {
    if (child.exitCode === null) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ['notification', 'queued invoke'] as const) {
  test(`Quit stops refresh reads and rejects ${mode} while still cleaning its live terminal`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'projector-shutdown-diagnostics-'));
    const project = join(root, 'project');
    await mkdir(project);
    const app = await electron.launch({
      args: [resolve('.')],
      env: {
        ...process.env,
        PROJECTOR_DATA: join(root, 'data'),
        PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 'runtime.json'),
      },
    });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, project);
      await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
      const pid = await page.evaluate(async (operationId) => {
        const bridge = (
          window as unknown as {
            projector: {
              invoke(method: string, params?: unknown): Promise<unknown>;
            };
          }
        ).projector;
        const state = (await bridge.invoke('snapshot')) as { projects: { id: string }[] };
        await bridge.invoke('applicationCommand', {
          action: 'newTerminal',
          projectId: state.projects[0].id,
          operationId,
        });
        const created = (await bridge.invoke('applicationSnapshot')) as {
          terminals: { pid: number }[];
        };
        return created.terminals[0].pid;
      }, randomUUID());
      await page.evaluate(() => {
        const bridge = (
          window as unknown as {
            projector: {
              invoke(method: string): Promise<unknown>;
              isShuttingDown(): boolean;
              onShutdown(callback: () => void): () => void;
              onRefresh(callback: () => void): () => void;
            };
          }
        ).projector;
        const probe = { shutdown: false, refreshes: 0, result: 'pending' };
        Object.assign(window, { shutdownProbe: probe });
        bridge.onRefresh(() => {
          if (probe.shutdown) probe.refreshes++;
        });
        bridge.onShutdown(() => {
          probe.shutdown = bridge.isShuttingDown();
          void bridge.invoke('applicationSnapshot').then(
            () => {
              probe.result = 'resolved';
            },
            (error) => {
              probe.result = String(error);
            },
          );
        });
      });
      await app.evaluate(({ app, BrowserWindow }, queuedInvoke) => {
        if (queuedInvoke) {
          // Reach the queued-request boundary before the renderer receives the
          // lifecycle notification, rather than testing only its local guard.
          const contents = BrowserWindow.getAllWindows().find(window => !window.getParentWindow())!.webContents;
          const send = contents.send.bind(contents);
          contents.send = (channel, ...args) => {
            if (channel !== 'projector:shutdown') send(channel, ...args);
          };
        }
        const quit = app.quit.bind(app);
        let calls = 0;
        // Keep only the final native exit behind a barrier. Real process cleanup,
        // runtime shutdown and the normal before-quit sequence still execute.
        app.quit = () => {
          if (++calls === 2) Object.assign(globalThis, { shutdownCleanupComplete: true });
          else quit();
        };
        setTimeout(() => app.quit(), 0);
      }, mode === 'queued invoke');
      await expect
        .poll(() =>
          app.evaluate(
            () =>
              (globalThis as unknown as { shutdownCleanupComplete?: boolean })
                .shutdownCleanupComplete,
          ),
        )
        .toBe(true);
      if (mode === 'queued invoke') {
        const rejected = await page.evaluate(async () => {
          const bridge = (
            window as unknown as { projector: { invoke(method: string): Promise<unknown> } }
          ).projector;
          try {
            await bridge.invoke('applicationSnapshot');
            return 'resolved';
          } catch (error) {
            return String(error);
          }
        });
        expect(rejected).toContain('Projector is shutting down.');
      }
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { shutdownProbe: { result: string } }).shutdownProbe.result,
          ),
        )
        .toContain('Projector is shutting down.');
      await app.evaluate(({ BrowserWindow }) => {
        // A queued notification arriving after the lifecycle message must not
        // restart a refresh subscription, even if its producer races shutdown.
        BrowserWindow.getAllWindows().find(window => !window.getParentWindow())!.webContents.send('projector:refresh');
      });
      const state = await page.evaluate(
        () =>
          (window as unknown as { shutdownProbe: { shutdown: boolean; refreshes: number } })
            .shutdownProbe,
      );
      expect(state).toMatchObject({ shutdown: true, refreshes: 0 });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
