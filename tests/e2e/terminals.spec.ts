import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import {
  paneLeaves,
  type ApplicationWorkspaceSnapshot,
} from '../../src/shared/application-workspace';
import type { TerminalRecord, TerminalScreen } from '../../src/shared/terminal';

interface Snapshot extends ApplicationWorkspaceSnapshot {
  terminals: TerminalRecord[];
}
interface Bridge {
  invoke(method: string, args?: Record<string, unknown>): Promise<unknown>;
}
let app: ElectronApplication | undefined;
let developmentServer: Awaited<ReturnType<typeof createServer>> | undefined;
let root: string;
test.afterEach(async () => {
  await app?.close();
  app = undefined;
  await developmentServer?.close();
  developmentServer = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});
async function invoke<T>(
  page: Page,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return page.evaluate(
    ({ method, args }) =>
      (window as unknown as { blueprint: Bridge }).blueprint.invoke(method, args),
    { method, args },
  ) as Promise<T>;
}
const snapshot = (page: Page) => invoke<Snapshot>(page, 'applicationSnapshot');
async function choose(page: Page, folder: string): Promise<string> {
  await app!.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, folder);
  await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
  const value = await invoke<{ projects: { id: string; path: string }[] }>(page, 'snapshot');
  const project = value.projects.find((project) =>
    project.path.endsWith('/' + folder.split('/').at(-1)),
  );
  if (!project) throw new Error('Disposable test project was not registered.');
  return project.id;
}
function terminalPane(value: Snapshot, key: string, terminalId: string) {
  const pane = value.workspaces[key].tabs
    .flatMap((tab) => paneLeaves(tab.root))
    .find((pane) => pane.content.kind === 'terminal' && pane.content.terminalId === terminalId);
  if (!pane) throw new Error('Terminal pane was not found.');
  return pane;
}
async function command(
  page: Page,
  projectId: string,
  action: string,
  args: Record<string, unknown> = {},
) {
  const current = action === 'select' ? null : (await snapshot(page)).selectedWorkspace;
  return invoke<ApplicationWorkspaceSnapshot>(page, 'applicationCommand', {
    projectId,
    action,
    ...(current ? { key: current } : {}),
    ...args,
  });
}
async function input(page: Page, id: string, viewId: string, data: string) {
  await invoke(page, 'terminalResize', { id, viewId, cols: 90, rows: 24, active: true });
  await invoke(page, 'terminalInput', { id, viewId, data });
}
async function screen(page: Page, id: string) {
  return invoke<TerminalScreen>(page, 'terminalScreen', { id });
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function setup(development = false) {
  root = await mkdtemp(join(tmpdir(), 'bp-terminals-ui-'));
  const data = join(root, 'data'),
    project = join(root, 'project'),
    other = join(root, 'other');
  await Promise.all([data, project, other].map((path) => mkdir(path)));
  let rendererUrl: string | undefined;
  if (development) {
    developmentServer = await createServer({
      configFile: false,
      root: resolve('src/renderer'),
      plugins: [react()],
      server: { host: '127.0.0.1', port: 0 },
    });
    await developmentServer.listen();
    const address = developmentServer.httpServer!.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing development renderer address.');
    rendererUrl = `http://127.0.0.1:${address.port}`;
  }
  const launch = () =>
    electron.launch({
      args: [resolve('.')],
      env: {
        ...process.env,
        BLUEPRINT_DATA: data,
        BLUEPRINT_RUNTIME_DESCRIPTOR: join(root, 'runtime.json'),
        ...(rendererUrl ? { ELECTRON_RENDERER_URL: rendererUrl } : {}),
      },
    });
  app = await launch();
  const page = await app.firstWindow();
  const projectId = await choose(page, project);
  const settings = (await snapshot(page)).settings;
  await invoke(page, 'applicationSettings', { ...settings, shell: '/bin/sh', shellArgs: ['-i'] });
  await command(page, projectId, 'select', { sessionId: null });
  return { page, projectId, other, launch };
}

test('real terminal tabs, nested splits and project terminals keep independent ownership when views close', async () => {
  const { page, projectId, other } = await setup();
  await page.getByRole('button', { name: 'New terminal', exact: true }).first().click();
  await expect.poll(async () => (await snapshot(page)).terminals.length).toBe(1);
  let value = await snapshot(page);
  const first = value.terminals[0],
    key = value.selectedWorkspace!;
  const firstPane = terminalPane(value, key, first.id);
  await input(page, first.id, firstPane.id, 'stty -echo; printf "\\nE2E_READY\\n"\r');
  await expect
    .poll(async () => (await screen(page, first.id)).content)
    .toContain('\r\nE2E_READY\r\n');

  // A real renderer xterm input event must reach the existing PTY without opening another shell.
  const firstView = page.locator(`[data-workspace-pane="${firstPane.id}"] .xterm-helper-textarea`);
  await firstView.focus();
  await page.keyboard.insertText('printf "\\n%s\\n" "輸入🙂"');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await screen(page, first.id)).content).toContain('\r\n輸入🙂\r\n');
  expect((await snapshot(page)).terminals[0].pid).toBe(first.pid);

  await page.getByRole('button', { name: 'Split right', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).terminals.length).toBe(2);
  value = await snapshot(page);
  const second = value.terminals.find((record) => record.id !== first.id)!;
  const secondPane = terminalPane(value, key, second.id);
  await page.getByRole('button', { name: 'Split down', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).terminals.length).toBe(3);
  value = await snapshot(page);
  const split = value.workspaces[key].tabs[0].root;
  expect(split.kind).toBe('split');
  if (split.kind !== 'split' || split.second.kind !== 'split')
    throw new Error('Expected nested splits.');
  expect(split.axis).toBe('horizontal');
  expect(split.second.axis).toBe('vertical');
  await command(page, projectId, 'ratio', { key, paneId: split.id, ratio: 0.62 });
  await expect(
    page.getByRole('separator', { name: 'Resize split panels' }).first(),
  ).toHaveAttribute('aria-valuenow', '62');

  // The same terminal may have several views; only the explicitly active view accepts input.
  await input(page, first.id, 'active-fixture-view', 'printf "\\nACTIVE_VIEW\\n"\r');
  await invoke(page, 'terminalResize', {
    id: first.id,
    viewId: 'background-fixture-view',
    cols: 20,
    rows: 5,
    active: false,
  });
  await expect(
    invoke(page, 'terminalInput', {
      id: first.id,
      viewId: 'background-fixture-view',
      data: 'bad input\r',
    }),
  ).rejects.toThrow(/Select the terminal pane/);
  await expect
    .poll(async () => (await screen(page, first.id)).content)
    .toContain('\r\nACTIVE_VIEW\r\n');
  await command(page, projectId, 'focus', { key, paneId: secondPane.id });
  await command(page, projectId, 'closePane', { key, paneId: secondPane.id });
  const closed = (await snapshot(page)).terminals.find((record) => record.id === second.id)!;
  expect(closed).toMatchObject({ status: 'running', pid: second.pid });
  expect(alive(second.pid!)).toBe(true);
  await command(page, projectId, 'showTerminal', { key, terminalId: second.id });
  value = await snapshot(page);
  expect(value.terminals).toHaveLength(3);
  const reopened = value.workspaces[key].tabs.find((tab) =>
    paneLeaves(tab.root).some(
      (pane) => pane.content.kind === 'terminal' && pane.content.terminalId === second.id,
    ),
  )!;
  await command(page, projectId, 'closeTab', { key, tabId: reopened.id });
  expect((await snapshot(page)).terminals.find((record) => record.id === second.id)?.pid).toBe(
    second.pid,
  );

  await page.getByRole('button', { name: 'Toggle project terminals', exact: true }).click();
  await page.getByRole('button', { name: 'New project terminal', exact: true }).first().click();
  await expect.poll(async () => (await snapshot(page)).bottom[projectId]?.tabs.length).toBe(1);
  value = await snapshot(page);
  const bottomId = value.bottom[projectId].tabs[0];
  const bottomPid = value.terminals.find((record) => record.id === bottomId)!.pid;
  await command(page, projectId, 'bottomHeight', { height: 330 });
  // These are synthetic workspace IDs, not discovered or launched Codex sessions.
  await command(page, projectId, 'select', { sessionId: 'fixture-session-a' });
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  const sessionA = (await snapshot(page)).selectedWorkspace!;
  await command(page, projectId, 'select', { sessionId: 'fixture-session-b' });
  expect((await snapshot(page)).workspaces[(await snapshot(page)).selectedWorkspace!].tabs).toEqual(
    [],
  );
  expect((await snapshot(page)).bottom[projectId]).toMatchObject({ tabs: [bottomId], height: 330 });
  await command(page, projectId, 'select', { sessionId: 'fixture-session-a' });
  expect((await snapshot(page)).workspaces[sessionA].tabs).toHaveLength(1);
  await command(page, projectId, 'bottomClose', { terminalId: bottomId });
  expect((await snapshot(page)).terminals.find((record) => record.id === bottomId)).toMatchObject({
    status: 'running',
    pid: bottomPid,
  });
  const otherId = await choose(page, other);
  await command(page, otherId, 'select', { sessionId: null });
  await command(page, otherId, 'newTerminal', { area: 'bottom', operationId: randomUUID() });
  value = await snapshot(page);
  expect(value.bottom[otherId].tabs).toHaveLength(1);
  expect(value.bottom[otherId].tabs).not.toContain(bottomId);
  expect(value.bottom[projectId].tabs).toEqual([]);
  expect(value.terminals.find((record) => record.id === first.id)).toMatchObject({
    projectId,
    pid: first.pid,
  });
});

test('renderer reload retains a live PID, Quit restores only saved screens, and Stop requires confirmation', async () => {
  const { page: initialPage, projectId, launch } = await setup();
  let page = initialPage;
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  let value = await snapshot(page);
  const key = value.selectedWorkspace!,
    terminal = value.terminals[0];
  const pane = terminalPane(value, key, terminal.id);
  await input(page, terminal.id, pane.id, 'stty -echo; printf "\\nBEFORE_RELOAD_🙂\\n"\r');
  await expect
    .poll(async () => (await screen(page, terminal.id)).content)
    .toContain('BEFORE_RELOAD_🙂');
  await page.reload();
  await expect(page.locator('.terminal-pane')).toHaveCount(1);
  expect((await snapshot(page)).terminals[0]).toMatchObject({
    id: terminal.id,
    pid: terminal.pid,
    status: 'running',
  });
  await input(page, terminal.id, pane.id, 'printf "\\nAFTER_RELOAD\\n"\r');
  await expect
    .poll(async () => (await screen(page, terminal.id)).content)
    .toContain('\r\nAFTER_RELOAD\r\n');
  value = await snapshot(page);
  const layout = value.workspaces[key];
  await app!.close();
  app = undefined;
  await expect.poll(() => alive(terminal.pid!)).toBe(false);
  app = await launch();
  page = await app.firstWindow();
  await expect(page.locator('.terminal-pane')).toHaveCount(1);
  value = await snapshot(page);
  expect(value.workspaces[key]).toEqual(layout);
  expect(value.terminals).toHaveLength(1);
  expect(value.terminals[0]).toMatchObject({ id: terminal.id, status: 'inactive' });
  expect(value.terminals[0].pid).toBeUndefined();
  expect((await screen(page, terminal.id)).content).toContain('AFTER_RELOAD');
  await expect(page.getByRole('button', { name: 'Restart terminal', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Restart terminal', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).terminals[0].status).toBe('running');
  const restarted = (await snapshot(page)).terminals[0];
  expect(restarted.pid).not.toBe(terminal.pid);
  await input(page, restarted.id, pane.id, 'sleep 120 & printf "STOP_CHILD:"; jobs -p\r');
  await expect
    .poll(async () => (await screen(page, restarted.id)).content)
    .toMatch(/STOP_CHILD:\d+/);
  const child = Number((await screen(page, restarted.id)).content.match(/STOP_CHILD:(\d+)/)![1]);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (_window, options?: Electron.MessageBoxOptions) => {
      process.env.BP_TERMINAL_STOP_DIALOG = JSON.stringify(options);
      return { response: 0, checkboxChecked: false };
    };
  });
  await page.getByRole('button', { name: 'Stop terminal', exact: true }).click();
  await expect
    .poll(() => app!.evaluate(() => process.env.BP_TERMINAL_STOP_DIALOG ?? ''))
    .not.toBe('');
  const prompt = JSON.parse(await app.evaluate(() => process.env.BP_TERMINAL_STOP_DIALOG!));
  expect(prompt).toMatchObject({ buttons: ['Cancel', 'Stop'], defaultId: 0, cancelId: 0 });
  expect((await snapshot(page)).terminals[0]).toMatchObject({
    status: 'running',
    pid: restarted.pid,
  });
  expect(alive(child)).toBe(true);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await page.getByRole('button', { name: 'Stop terminal', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).terminals[0].status).toBe('exited');
  expect(alive(restarted.pid!)).toBe(false);
  expect(alive(child)).toBe(false);
});

test('development renderer sends real xterm input and renders a live output subscription', async () => {
  const { page } = await setup(true);
  await page.getByRole('button', { name: 'New terminal', exact: true }).first().click();
  await expect.poll(async () => (await snapshot(page)).terminals.length).toBe(1);
  const value = await snapshot(page),
    terminal = value.terminals[0];
  const pane = terminalPane(value, value.selectedWorkspace!, terminal.id);
  await input(page, terminal.id, pane.id, 'stty -echo; printf "\\nDEVELOPMENT_READY\\n"\r');
  await expect
    .poll(async () => (await screen(page, terminal.id)).content)
    .toContain('\r\nDEVELOPMENT_READY\r\n');
  await page.locator(`[data-workspace-pane="${pane.id}"] .xterm-helper-textarea`).focus();
  await page.keyboard.insertText('printf "\\n%s\\n" "DEV輸入🙂"');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await screen(page, terminal.id)).content)
    .toContain('\r\nDEV輸入🙂\r\n');
  // The DOM assertion proves that the output subscription displays fresh shell output,
  // in addition to the service-side screen assertion above.
  await expect(page.locator('.terminal-pane .xterm-rows')).toContainText('DEV輸入🙂');
});

test('terminal screen write failure stays visible and recovered saving plus live history limits are disclosed', async () => {
  const { page, projectId } = await setup();
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  let value = await snapshot(page);
  const terminal = value.terminals[0],
    key = value.selectedWorkspace!,
    pane = terminalPane(value, key, terminal.id),
    savedScreen = join(root, 'data', 'terminals', `${terminal.id}.json`);
  await input(page, terminal.id, pane.id, 'stty -echo; printf "\\nSAVE_READY\\n"\r');
  await expect(page.locator('.terminal-pane .xterm-rows')).toContainText('SAVE_READY');
  await expect
    .poll(async () => await readFile(savedScreen, 'utf8').catch(() => ''))
    .toContain('SAVE_READY');
  // A real filesystem failure leaves the live PTY and in-memory screen available.
  await rm(savedScreen);
  await mkdir(savedScreen);
  await input(page, terminal.id, pane.id, 'printf "\\nUNSAVED_SCREEN\\n"\r');
  await expect
    .poll(
      async () =>
        (await snapshot(page)).terminals.find((record) => record.id === terminal.id)?.error,
    )
    .toBe('Terminal screen could not be saved. Check local storage.');
  await expect(page.locator('.terminal-pane').getByRole('alert')).toContainText(
    'Terminal screen could not be saved. Check local storage.',
  );
  expect(
    (await snapshot(page)).terminals.find((record) => record.id === terminal.id),
  ).toMatchObject({ status: 'running', pid: terminal.pid });
  await expect(page.locator('.terminal-pane .xterm-rows')).toContainText('UNSAVED_SCREEN');
  await rm(savedScreen, { recursive: true });
  await input(page, terminal.id, pane.id, 'printf "\\nSAVING_RECOVERED\\n"\r');
  await expect
    .poll(async () => await readFile(savedScreen, 'utf8').catch(() => ''))
    .toContain('SAVING_RECOVERED');
  await expect(page.locator('.terminal-pane').getByRole('alert')).toHaveCount(0);
  await invoke(page, 'applicationSettings', {
    ...(await snapshot(page)).settings,
    terminalScrollback: 500,
  });
  await input(
    page,
    terminal.id,
    pane.id,
    'i=0; while [ "$i" -lt 400 ]; do printf "CONFIG_HISTORY:%04d\\n" "$i"; i=$((i+1)); done\r',
  );
  await expect
    .poll(async () => (await screen(page, terminal.id)).content)
    .toContain('CONFIG_HISTORY:0399');
  await expect(
    page.locator('.terminal-pane').getByText('Output truncated', { exact: true }),
  ).toHaveCount(0);
  // Reducing the limit must disclose removal immediately, without another output.
  await invoke(page, 'applicationSettings', {
    ...(await snapshot(page)).settings,
    terminalScrollback: 100,
  });
  await expect(
    page.locator('.terminal-pane').getByText('Output truncated', { exact: true }),
  ).toBeVisible();
  expect((await screen(page, terminal.id)).content).not.toContain('CONFIG_HISTORY:0000');
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  value = await snapshot(page);
  const streaming = value.terminals.find((record) => record.id !== terminal.id)!,
    streamingPane = terminalPane(value, key, streaming.id);
  await input(
    page,
    streaming.id,
    streamingPane.id,
    'stty -echo; i=0; while [ "$i" -lt 400 ]; do printf "LIVE_HISTORY:%04d\\n" "$i"; i=$((i+1)); done\r',
  );
  await expect
    .poll(async () => (await screen(page, streaming.id)).content)
    .toContain('LIVE_HISTORY:0399');
  await expect(
    page.locator('.terminal-pane').getByText('Output truncated', { exact: true }),
  ).toBeVisible();
  expect((await screen(page, streaming.id)).content).not.toContain('LIVE_HISTORY:0000');
});

test('utility crash restores a confirmed screen and explicit restart renews real xterm input and viewport', async () => {
  const { page, projectId } = await setup();
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  const value = await snapshot(page),
    terminal = value.terminals[0],
    pane = terminalPane(value, value.selectedWorkspace!, terminal.id),
    savedScreen = join(root, 'data', 'terminals', `${terminal.id}.json`);
  await input(page, terminal.id, pane.id, 'stty -echo; printf "\\nCRASH_UI_READY\\n"\r');
  await expect(page.locator('.terminal-pane .xterm-rows')).toContainText('CRASH_UI_READY');
  await expect
    .poll(async () => await readFile(savedScreen, 'utf8').catch(() => ''))
    .toContain('CRASH_UI_READY');
  await input(page, terminal.id, pane.id, 'printf "\\nUNCONFIRMED_UI_OUTPUT\\n"\r');
  await expect(page.locator('.terminal-pane .xterm-rows')).toContainText('UNCONFIRMED_UI_OUTPUT');
  await app!.evaluate(({ app }) => {
    const helper = app.getAppMetrics().find((entry) => entry.name === 'Blueprint Terminals');
    if (!helper) throw new Error('Missing dedicated terminal utility service');
    process.kill(helper.pid, 'SIGKILL');
  });
  await expect.poll(async () => (await snapshot(page)).terminals[0].status).toBe('inactive');
  await expect.poll(() => alive(terminal.pid!)).toBe(false);
  await page.getByRole('button', { name: 'Restart terminal', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await snapshot(page)).terminals.find((record) => record.id === terminal.id)?.status,
    )
    .toBe('running');
  await page.locator('.terminal-pane .xterm-helper-textarea').focus();
  // Use real xterm input, without the test helper that explicitly claims activeView.
  await page.keyboard.insertText('stty -echo; printf "\\n%s\\n" "AFTER_SERVICE_RESTART_🙂"');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await screen(page, terminal.id)).content)
    .toContain('\r\nAFTER_SERVICE_RESTART_🙂\r\n');
  await expect(page.locator('.terminal-pane .xterm-rows')).toContainText(
    'AFTER_SERVICE_RESTART_🙂',
  );
  expect((await snapshot(page)).terminals[0].pid).not.toBe(terminal.pid);
  const current = await screen(page, terminal.id);
  expect(current.cols).toBeGreaterThan(2);
  expect(current.rows).toBeGreaterThan(1);
});

test('manual split follows the source shell current cwd after cd and persists it for inactive restoration', async () => {
  const { page, projectId, launch } = await setup();
  const folder = join(root, 'project', 'nested folder 日本語');
  await mkdir(folder);
  const canonical = await realpath(folder);
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  let value = await snapshot(page);
  const source = value.terminals[0],
    key = value.selectedWorkspace!,
    pane = terminalPane(value, key, source.id);
  await input(
    page,
    source.id,
    pane.id,
    `stty -echo; cd '${folder.replaceAll("'", "'\\''")}'; printf "\\nCWD_CHANGED\\n"\r`,
  );
  await expect
    .poll(async () => (await screen(page, source.id)).content)
    .toContain('\r\nCWD_CHANGED\r\n');
  await command(page, projectId, 'split', {
    paneId: pane.id,
    axis: 'horizontal',
    operationId: randomUUID(),
  });
  value = await snapshot(page);
  const split = value.terminals.find((record) => record.id !== source.id)!,
    splitPane = terminalPane(value, key, split.id);
  await input(page, split.id, splitPane.id, 'stty -echo; printf "\\nSPLIT_CWD:"; pwd -P\r');
  await expect
    .poll(async () => (await screen(page, split.id)).content)
    .toContain(`SPLIT_CWD:${canonical}`);
  expect(value.terminals.find((record) => record.id === source.id)?.cwd).toBe(canonical);
  expect(split.cwd).toBe(canonical);
  await app!.close();
  app = undefined;
  app = await launch();
  const restoredPage = await app.firstWindow();
  await expect.poll(async () => (await snapshot(restoredPage)).terminals.length).toBe(2);
  const restored = (await snapshot(restoredPage)).terminals;
  expect(restored).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: source.id, cwd: canonical, status: 'inactive' }),
      expect.objectContaining({ id: split.id, cwd: canonical, status: 'inactive' }),
    ]),
  );
  expect(restored.every((record) => record.pid === undefined)).toBe(true);
});
