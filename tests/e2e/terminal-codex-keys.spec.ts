import { test, expect, electron, type ElectronApplication } from './test';
import { notificationWindow } from './notification-window';
import { spawnSync } from '../support/process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ApplicationWorkspaceSnapshot } from '../../src/shared/application-workspace';
import type { HarnessSnapshot } from '../../src/shared/harness';
import type { TerminalRecord } from '../../src/shared/terminal';

type Snapshot = ApplicationWorkspaceSnapshot & {
  terminals: TerminalRecord[];
  harnesses: HarnessSnapshot;
};
test('installed Codex receives Ctrl+D and Ctrl+C through xterm for independently launched owned TUI processes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'projector-codex-keys-')));
  const project = join(root, 'project'),
    home = join(root, 'home'),
    data = join(root, 'data');
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([project, home, data].map((path) => mkdir(path)));
    const lookup = spawnSync('/usr/bin/which', ['codex'], { encoding: 'utf8' });
    expect(lookup.status, lookup.stderr).toBe(0);
    const executable = lookup.stdout.trim();
    await writeFile(
      join(home, 'config.toml'),
      `model="gpt-6.1-sol"\nmodel_provider="local"\ncli_auth_credentials_store="file"\ncheck_for_update_on_startup=false\n[features]\nplugins=false\nremote_plugin=false\n[analytics]\nenabled=false\n[tui]\nshow_welcome_banner=false\n[model_providers.local]\nname="Isolated terminal qualification"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`,
    );
    app = await electron.launch({
      args: [resolve('.')],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        CODEX_HOME: home,
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        LANG: 'en_US.UTF-8',
        PROJECTOR_DATA: data,
        PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 'endpoint.json'),
        PROJECTOR_E2E_BACKGROUND: process.env.PROJECTOR_E2E_BACKGROUND ?? '1',
        ...(process.env.PROJECTOR_E2E_WINDOW_AUDIT
          ? { PROJECTOR_E2E_WINDOW_AUDIT: process.env.PROJECTOR_E2E_WINDOW_AUDIT }
          : {}),
        PROJECTOR_E2E_CODEX_EXECUTABLE: executable,
      },
    });
    const page = await app.firstWindow();
    const invoke = <T>(name: string, args: Record<string, unknown> = {}) =>
      page.evaluate(
        ({ name, args }) =>
          (
            window as unknown as {
              projector: { invoke(name: string, args: Record<string, unknown>): Promise<T> };
            }
          ).projector.invoke(name, args),
        { name, args },
      );
    const snapshot = () => invoke<Snapshot>('applicationSnapshot');
    // A model header does not prove startup has completed. Qualify the exact
    // owned TUI before sending its idle exit chord rather than cancelling MCP.
    const ready = (terminalId: string) => expect.poll(async () =>
      (await snapshot()).harnesses.mcpStartup.find(connection => connection.terminalId === terminalId)?.status,
    ).toBe('ready');
    await app.evaluate(({ dialog }, project) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
    }, project);
    await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
    const projectId = (await invoke<{ projects: { id: string }[] }>('snapshot')).projects[0].id;
    await invoke('applicationSettings', {
      ...(await snapshot()).settings,
      codexExecutable: executable,
    });
    await invoke('applicationCommand', {
      action: 'newCodex',
      projectId,
      operationId: randomUUID(),
    });
    await expect.poll(async () => (await snapshot()).terminals[0]?.harnessSessionId).toBeTruthy();
    const created = (await snapshot()).terminals[0];
    const keyboard = page.locator('.terminal-pane .xterm-helper-textarea');
    await expect(page.locator('.terminal-pane .xterm-rows')).toContainText(/gpt-6\.1-sol/i);
    await ready(created.id);
    const row = page.locator('.project-session-row').filter({
      has: page.getByRole('button', { name: 'Untitled session', exact: true }),
    });
    await row.hover();
    await row.getByRole('button', { name: 'Archive Untitled session', exact: true }).click();
    const notices = (await notificationWindow(app)).locator('.notification-alert');
    await expect(notices.filter({ hasText: 'Session is in use' })).toHaveCount(1);
    await expect(notices.filter({ hasText: 'thread not loaded' })).toHaveCount(0);
    expect((await snapshot()).terminals[0].harnessSessionId).toBe(created.harnessSessionId);
    expect((await snapshot()).harnesses.error).toBeNull();
    await keyboard.focus();
    await keyboard.press('Control+d');
    await expect.poll(async () => (await snapshot()).terminals).toEqual([]);
    await invoke('applicationCommand', {
      action: 'newCodex',
      projectId,
      operationId: randomUUID(),
    });
    await expect.poll(async () => (await snapshot()).terminals[0]?.harnessSessionId).toBeTruthy();
    const next = (await snapshot()).terminals[0];
    expect(next.harnessSessionId).not.toBe(created.harnessSessionId);
    await expect(page.locator('.terminal-pane .xterm-rows')).toContainText(/gpt-6\.1-sol/i);
    await ready(next.id);
    await keyboard.focus();
    await keyboard.press('Control+c');
    // The fully initialized installed TUI must exit on the actual idle chord.
    // Never send another chord to an exited record retained during cleanup.
    await expect.poll(async () => (await snapshot()).terminals).toEqual([]);
    await expect(page.locator('.terminal-pane')).toHaveCount(0);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
