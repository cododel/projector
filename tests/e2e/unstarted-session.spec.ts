import { test, expect, electron, type ElectronApplication } from './test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ApplicationWorkspaceSnapshot } from '../../src/shared/application-workspace';
import type { HarnessSnapshot } from '../../src/shared/harness';
import type { TerminalRecord } from '../../src/shared/terminal';

test('closing a new session before its first turn removes the unavailable row and preserves its workspace', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bp-unstarted-ui-')));
  let app: ElectronApplication | undefined;
  try {
    const project = join(root, 'project'); await mkdir(project);
    app = await electron.launch({ args: [resolve('.')], env: {
      ...process.env, PROJECTOR_DATA: join(root, 'data'), CODEX_HOME: join(root, 'home'),
      PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 'endpoint.json'), CODEX_FIXTURE_PROJECT: project,
      CODEX_FIXTURE_EMPTY: '1', PROJECTOR_E2E_HARNESS_INTERVAL_MS: '60000',
    } });
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, project) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, project);
    await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
    await page.getByRole('button', { name: 'New Codex session in project', exact: true }).click();
    const snapshot = () => page.evaluate(() => (window as unknown as {
      projector: { invoke(name: string): Promise<ApplicationWorkspaceSnapshot & { harnesses: HarnessSnapshot; terminals: TerminalRecord[] }> }
    }).projector.invoke('applicationSnapshot'));
    await expect.poll(async () => (await snapshot()).harnesses.sessions.length).toBe(1);
    await expect(page.locator('.terminal-pane.active .xterm-helper-textarea')).toBeFocused();
    const before = await snapshot();
    const session = before.harnesses.sessions[0];
    await page.evaluate(id => (window as unknown as {
      projector: { invoke(name: string, args: { id: string }): Promise<unknown> }
    }).projector.invoke('terminalStop', { id }), session.terminalId!);
    await expect.poll(async () => (await snapshot()).harnesses.sessions.length).toBe(0);
    const after = await snapshot();
    expect(Object.keys(after.workspaces)).toEqual(Object.keys(before.workspaces));
    await expect(page.locator('.harness-session')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start new session', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('CODEX_RPC_FAILED');
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
});
