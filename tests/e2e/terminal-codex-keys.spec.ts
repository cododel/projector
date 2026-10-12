import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ApplicationWorkspaceSnapshot } from '../../src/shared/application-workspace';
import type { HarnessSnapshot } from '../../src/shared/harness';
import type { TerminalRecord } from '../../src/shared/terminal';

type Snapshot = ApplicationWorkspaceSnapshot & {
  terminals: TerminalRecord[];
  harnesses: HarnessSnapshot;
};
test('installed Codex receives Ctrl+D and Ctrl+C through xterm for independently launched owned TUI processes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bp-codex-keys-')));
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
      `model="gpt-5.4"\nmodel_provider="local"\ncli_auth_credentials_store="file"\ncheck_for_update_on_startup=false\n[analytics]\nenabled=false\n[tui]\nshow_welcome_banner=false\n[model_providers.local]\nname="Isolated terminal qualification"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`,
    );
    app = await electron.launch({
      args: [resolve('.')],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        CODEX_HOME: home,
        TMPDIR: root,
        LANG: 'en_US.UTF-8',
        BLUEPRINT_DATA: data,
        BLUEPRINT_RUNTIME_DESCRIPTOR: join(root, 'endpoint.json'),
        BLUEPRINT_E2E_BACKGROUND: process.env.BLUEPRINT_E2E_BACKGROUND ?? '1',
        ...(process.env.BLUEPRINT_E2E_WINDOW_AUDIT
          ? { BLUEPRINT_E2E_WINDOW_AUDIT: process.env.BLUEPRINT_E2E_WINDOW_AUDIT }
          : {}),
        BLUEPRINT_E2E_CODEX_EXECUTABLE: executable,
      },
    });
    const page = await app.firstWindow();
    const invoke = <T>(name: string, args: Record<string, unknown> = {}) =>
      page.evaluate(
        ({ name, args }) =>
          (
            window as unknown as {
              blueprint: { invoke(name: string, args: Record<string, unknown>): Promise<T> };
            }
          ).blueprint.invoke(name, args),
        { name, args },
      );
    const snapshot = () => invoke<Snapshot>('applicationSnapshot');
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
    await expect(page.locator('.terminal-pane .xterm-rows')).toContainText('gpt-5.4');
    await keyboard.focus();
    await keyboard.press('Control+d');
    await expect.poll(async () => (await snapshot()).terminals).toEqual([]);
    await invoke('applicationCommand', {
      action: 'newCodex',
      projectId,
      operationId: randomUUID(),
    });
    await expect.poll(async () => (await snapshot()).terminals[0]?.harnessSessionId).toBeTruthy();
    expect((await snapshot()).terminals[0].harnessSessionId).not.toBe(created.harnessSessionId);
    await expect(page.locator('.terminal-pane .xterm-rows')).toContainText('gpt-5.4');
    await keyboard.focus();
    await keyboard.press('Control+c');
    // Codex may ask for a second Ctrl+C at idle. Never replace either with Stop.
    if ((await snapshot()).terminals.length) await keyboard.press('Control+c');
    await expect.poll(async () => (await snapshot()).terminals).toEqual([]);
    await expect(page.locator('.terminal-pane')).toHaveCount(0);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
