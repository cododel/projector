import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
  const sessionB = (await snapshot(page)).workspaces[(await snapshot(page)).selectedWorkspace!];
  expect(sessionB.tabs).toHaveLength(1);
  expect(paneLeaves(sessionB.tabs[0].root)[0].content).toEqual({
    kind: 'session',
    sessionId: 'fixture-session-b',
  });
  expect((await snapshot(page)).bottom[projectId]).toMatchObject({ tabs: [bottomId], height: 330 });
  await command(page, projectId, 'select', { sessionId: 'fixture-session-a' });
  expect((await snapshot(page)).workspaces[sessionA].tabs).toHaveLength(2);
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

test('renderer reload retains a live PID, Quit removes ended terminals, and Stop requires confirmation', async () => {
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
  await app!.close();
  app = undefined;
  await expect.poll(() => alive(terminal.pid!)).toBe(false);
  app = await launch();
  page = await app.firstWindow();
  await expect(page.locator('.terminal-pane')).toHaveCount(0);
  value = await snapshot(page);
  expect(value.terminals).toEqual([]);
  expect(value.workspaces[key].tabs).toEqual([]);
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  const restarted = (await snapshot(page)).terminals[0];
  const restartedPane = terminalPane(await snapshot(page), key, restarted.id);
  expect(restarted.id).not.toBe(terminal.id);
  expect(restarted.pid).not.toBe(terminal.pid);
  await input(page, restarted.id, restartedPane.id, 'sleep 120 & printf "STOP_CHILD:"; jobs -p\r');
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
  await expect.poll(async () => (await snapshot(page)).terminals).toEqual([]);
  await expect(page.locator('.terminal-pane')).toHaveCount(0);
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

test('utility crash removes ended processes and an explicit new terminal receives real xterm input', async () => {
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
  await expect.poll(async () => (await snapshot(page)).terminals).toEqual([]);
  await expect.poll(() => alive(terminal.pid!)).toBe(false);
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  const fresh = (await snapshot(page)).terminals[0];
  expect(fresh.id).not.toBe(terminal.id);
  await page.locator('.terminal-pane .xterm-helper-textarea').focus();
  // Use real xterm input, without the test helper that explicitly claims activeView.
  await page.keyboard.insertText('stty -echo; printf "\\n%s\\n" "AFTER_SERVICE_RESTART_🙂"');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => (await screen(page, fresh.id)).content)
    .toContain('\r\nAFTER_SERVICE_RESTART_🙂\r\n');
  await expect(page.locator('.terminal-pane .xterm-rows')).toContainText(
    'AFTER_SERVICE_RESTART_🙂',
  );
  expect((await snapshot(page)).terminals[0].pid).not.toBe(terminal.pid);
  const current = await screen(page, fresh.id);
  expect(current.cols).toBeGreaterThan(2);
  expect(current.rows).toBeGreaterThan(1);
});

test('manual split follows source cwd and Quit removes both ended terminals', async () => {
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
  await expect.poll(async () => (await snapshot(restoredPage)).terminals).toEqual([]);
  expect((await snapshot(restoredPage)).workspaces[key].tabs).toEqual([]);
});

test('failed terminal removal offers Retry cleanup and retires the view after storage recovers', async () => {
  const { page, projectId } = await setup();
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  const terminal = (await snapshot(page)).terminals[0];
  const catalog = join(root, 'data', 'terminals', 'catalog.json');
  await app!.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await rm(catalog);
  await mkdir(catalog);
  await page.getByRole('button', { name: 'Stop terminal', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Retry terminal cleanup', exact: true }),
  ).toBeVisible();
  expect(alive(terminal.pid!)).toBe(false);
  expect((await snapshot(page)).terminals[0]).toMatchObject({
    id: terminal.id,
    error: expect.stringContaining('removed'),
  });
  await rm(catalog, { recursive: true });
  await page.getByRole('button', { name: 'Retry terminal cleanup', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).terminals).toEqual([]);
  await expect(page.locator('.terminal-pane')).toHaveCount(0);
});

test('real xterm forwards standard control and navigation chords to a raw PTY and Ctrl+D exits it', async () => {
  const { page, projectId } = await setup();
  const settings = (await snapshot(page)).settings;
  await invoke(page, 'applicationSettings', {
    ...settings,
    shell: resolve('tests/fixtures/terminal-keyboard.mjs'),
    shellArgs: [],
  });
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  const value = await snapshot(page),
    terminal = value.terminals[0];
  await expect(page.locator('.terminal-pane .xterm-rows')).toContainText('KEY_READY');
  const keyboard = page.locator('.terminal-pane .xterm-helper-textarea');
  await keyboard.focus();
  let expectedKeys = '';
  for (const [chord, hex] of [
    ['Control+c', '03'],
    ['Control+a', '01'],
    ['Control+e', '05'],
    ['Control+b', '02'],
    ['Control+f', '06'],
    ['Control+u', '15'],
    ['Control+k', '0b'],
    ['Control+w', '17'],
    ['Control+r', '12'],
    ['Control+l', '0c'],
    ['Control+z', '1a'],
    ['Control+s', '13'],
    ['Control+q', '11'],
    ['Control+g', '07'],
    ['Control+h', '08'],
    ['Control+i', '09'],
    ['Control+j', '0a'],
    ['Control+m', '0d'],
    ['Control+n', '0e'],
    ['Control+o', '0f'],
    ['Control+p', '10'],
    ['Control+t', '14'],
    ['Control+v', '16'],
    ['Control+y', '19'],
    ['Control+[', '1b'],
    ['Control+\\', '1c'],

    ['ArrowLeft', '1b5b44'],
    ['ArrowRight', '1b5b43'],
    ['ArrowUp', '1b5b41'],
    ['ArrowDown', '1b5b42'],
    ['Home', '1b5b48'],
    ['End', '1b5b46'],
    ['Delete', '1b5b337e'],
    ['Backspace', '7f'],
    ['Tab', '09'],
    ['Enter', '0d'],
  ]) {
    await keyboard.press(chord);
    expectedKeys += hex;
    await expect
      .poll(
        async () =>
          [...(await screen(page, terminal.id)).content.matchAll(/KEY:([0-9a-f]+)/g)]
            .map((match) => match[1])
            .join(''),
        { message: chord },
      )
      .toBe(expectedKeys);
  }
  await keyboard.press('Control+d');
  await expect.poll(async () => (await snapshot(page)).terminals).toEqual([]);
  expect(alive(terminal.pid!)).toBe(false);
});

test('Ctrl+C interrupts a real foreground command; Ctrl+D provides EOF then exits the idle shell', async () => {
  const { page, projectId } = await setup();
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  const terminal = (await snapshot(page)).terminals[0];
  const keyboard = page.locator('.terminal-pane .xterm-helper-textarea');
  await keyboard.focus();
  await page.keyboard.insertText('stty -echo; echo SHELL_READY');
  await keyboard.press('Enter');
  await expect
    .poll(async () => (await screen(page, terminal.id)).content)
    .toContain('\r\nSHELL_READY\r\n');
  await page.keyboard.insertText(
    'node -e \'process.on("SIGINT",()=>process.exit(130)); console.log("INTERRUPT_WAITING"); setInterval(()=>{},1000)\'; echo INTERRUPT_RESULT:$?',
  );
  await keyboard.press('Enter');
  await expect
    .poll(async () => (await screen(page, terminal.id)).content)
    .toContain('INTERRUPT_WAITING');
  await keyboard.press('Control+c');
  await expect
    .poll(async () => (await screen(page, terminal.id)).content)
    .toContain('INTERRUPT_RESULT:130');
  expect(alive(terminal.pid!)).toBe(true);
  await page.keyboard.insertText('printf "\\nCAT_WAITING\\n"; cat; echo EOF_RETURNED');
  await keyboard.press('Enter');
  await expect.poll(async () => (await screen(page, terminal.id)).content).toContain('CAT_WAITING');
  await keyboard.press('Control+d');
  await expect
    .poll(async () => (await screen(page, terminal.id)).content)
    .toContain('\r\nEOF_RETURNED\r\n');
  await keyboard.press('Control+d');
  await expect.poll(async () => (await snapshot(page)).terminals).toEqual([]);
});

test('control input survives a pending real PTY resize acknowledgement without replay or loss', async () => {
  const { page, projectId } = await setup();
  const settings = (await snapshot(page)).settings;
  await invoke(page, 'applicationSettings', {
    ...settings,
    shell: resolve('tests/fixtures/terminal-keyboard.mjs'),
    shellArgs: [],
  });
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  const terminal = (await snapshot(page)).terminals[0];
  await expect(page.locator('.terminal-pane .xterm-rows')).toContainText('KEY_READY');
  const keyboard = page.locator('.terminal-pane .xterm-helper-textarea');
  await keyboard.focus();
  const servicePid = await app!.evaluate(({ app }) => {
    const service = app.getAppMetrics().find((entry) => entry.name === 'Blueprint Terminals');
    if (!service) throw new Error('Missing owned terminal service');
    return service.pid;
  });
  const pressDuringResize = async (chord: string, afterPress?: () => Promise<void>) => {
    process.kill(servicePid, 'SIGSTOP');
    try {
      await page.locator('.xterm-container').evaluate(async (el) => {
        el.style.width = `${el.clientWidth - 60}px`;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await keyboard.press(chord);
      await afterPress?.();
    } finally {
      process.kill(servicePid, 'SIGCONT');
    }
  };
  await pressDuringResize('Control+c');
  await expect.poll(async () => (await screen(page, terminal.id)).content).toContain('KEY:03');
  expect((await screen(page, terminal.id)).content.match(/KEY:03/g)).toHaveLength(1);
  // A renderer reload cancels unsent input; restoring its view must not inject it later.
  await pressDuringResize('Control+a', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.terminal-pane')).toHaveCount(0);
  });
  expect((await screen(page, terminal.id)).content).not.toContain('KEY:01');
  await expect(page.locator('.terminal-pane .xterm-rows')).toContainText('KEY:03');
  await keyboard.focus();
  await pressDuringResize('Control+d');
  await expect.poll(async () => (await snapshot(page)).terminals).toEqual([]);
});

test('native-backed files drop into an inactive terminal as quoted paths without Enter or duplicate input', async () => {
  const { page, projectId } = await setup();
  await invoke(page, 'applicationSettings', {
    ...(await snapshot(page)).settings,
    shell: resolve('tests/fixtures/terminal-keyboard.mjs'),
    shellArgs: [],
  });
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  await expect(page.locator('.terminal-pane .xterm-rows')).toContainText('KEY_READY');
  await command(page, projectId, 'split', {
    axis: 'horizontal',
    paneId: (await snapshot(page)).workspaces[(await snapshot(page)).selectedWorkspace!]
      .activePaneId,
    operationId: randomUUID(),
  });
  await expect(page.locator('.terminal-pane')).toHaveCount(2);
  await expect(page.locator('.terminal-pane').nth(1).locator('.xterm-rows')).toContainText(
    'KEY_READY',
  );
  const paths = [join(root, 'image with spaces.png'), join(root, "quoted'$(noop).txt")];
  await Promise.all(paths.map((path) => writeFile(path, 'local fixture')));
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = 'native-drop-files';
    input.hidden = true;
    document.body.append(input);
  });
  await page.locator('#native-drop-files').setInputFiles(paths);
  await page
    .locator('.terminal-pane')
    .first()
    .evaluate((element) => {
      const files = (document.querySelector('#native-drop-files') as HTMLInputElement).files!;
      const dataTransfer = new DataTransfer();
      for (const file of files) dataTransfer.items.add(file);
      element.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }),
      );
      element.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
      );
    });
  const first = page.locator('.terminal-pane').first();
  await expect(first).toHaveClass(/active/);
  const expected = paths.map((path) => "'" + path.replaceAll("'", "'\"'\"'") + "'").join(' ') + ' ';
  await expect(first.locator('.xterm-rows')).toContainText(
    'KEY:' + Buffer.from(expected).toString('hex'),
  );
  await expect(first.locator('.xterm-helper-textarea')).toBeFocused();
  const second = page.locator('.terminal-pane').nth(1);
  await expect(second.locator('.xterm-rows')).not.toContainText('KEY:');
  expect(await page.url()).toContain('blueprint://');
});

for (const mode of ['mouse', 'arrows'])
  test(`wheel magnitude survives xterm ${mode} TUI protocol with fractional accumulation and no duplicates`, async () => {
    const { page, projectId } = await setup();
    await invoke(page, 'applicationSettings', {
      ...(await snapshot(page)).settings,
      shell: resolve('tests/fixtures/terminal-wheel.mjs'),
      shellArgs: [mode],
    });
    await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
    const rows = page.locator('.terminal-pane .xterm-rows');
    await expect(rows).toContainText('WHEEL_READY');
    await page.locator('.xterm-helper-textarea').focus();
    const wheel = (deltaY: number, deltaMode = 1, deltaX = 0) =>
      page.locator('.xterm-screen').evaluate(
        (element, delta) => {
          const rect = element.getBoundingClientRect();
          element.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaY: delta.deltaY,
              deltaX: delta.deltaX,
              deltaMode: delta.deltaMode,
              clientX: rect.x + 40,
              clientY: rect.y + 40,
            }),
          );
        },
        { deltaY, deltaMode, deltaX },
      );
    await wheel(-5, 1, 0.1);
    await expect(rows).toContainText('SCROLL_UP=5 DOWN=0');
    await wheel(10);
    await expect(rows).toContainText('SCROLL_UP=5 DOWN=10');
    const height = await page
      .locator('.xterm-rows > div')
      .first()
      .evaluate((el) => el.getBoundingClientRect().height);
    for (let i = 0; i < 4; i++) await wheel(height / 4, 0);
    await expect(rows).toContainText('SCROLL_UP=5 DOWN=11');
    await observeWheelPackets();
    const rowCount = await page.locator('.xterm-rows > div').count();
    await wheel(100000);
    await expect(rows).toContainText(`SCROLL_UP=5 DOWN=${11 + 2 * rowCount}`);
    const packets = await wheelPackets();
    const lengths = packets.map((packet) => packet.data.split('\x1b').length - 1);
    expect(lengths.reduce((a, b) => a + b, 0)).toBe(2 * rowCount);
    expect(lengths.every((length) => length > 0 && length <= 16)).toBe(true);
    expect(packets).toHaveLength(Math.ceil((2 * rowCount) / 16));
    await page.locator('.xterm-screen').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      for (const deltaY of [-50, 3])
        element.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY,
            deltaMode: 1,
            clientX: rect.x + 40,
            clientY: rect.y + 40,
          }),
        );
    });
    await expect(rows).toContainText(`SCROLL_UP=5 DOWN=${14 + 2 * rowCount}`);
    await page.locator('.xterm-screen').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -1,
          deltaMode: 1,
          altKey: true,
          clientX: rect.x + 40,
          clientY: rect.y + 40,
        }),
      );
    });
    await expect(rows).toContainText(`SCROLL_UP=10 DOWN=${14 + 2 * rowCount}`);
  });

async function observeWheelPackets() {
  const probe = join(root, 'wheel-ipc-probe.cjs');
  await writeFile(probe, 'process.parentPort.on("message", () => {});');
  await app!.evaluate(({ utilityProcess }, path) => {
    const probe = utilityProcess.fork(path, [], { stdio: 'ignore' });
    const prototype = Object.getPrototypeOf(probe);
    const original = prototype.postMessage;
    const state = globalThis as unknown as { wheelPackets: { data: string; at: number }[] };
    state.wheelPackets = [];
    prototype.postMessage = function (
      message: { method?: string; args?: { data?: string } },
      ...rest: unknown[]
    ) {
      if (message.method === 'input' && message.args?.data)
        state.wheelPackets.push({ data: message.args.data, at: Date.now() });
      return Reflect.apply(original, this, [message, ...rest]);
    };
    probe.kill();
  }, probe);
}
const wheelPackets = () =>
  app!.evaluate(
    () => (globalThis as unknown as { wheelPackets: { data: string; at: number }[] }).wheelPackets,
  );

test('warmed wheel input is batched and measured through real PTY and DOM paint; normal scrollback never sends input', async () => {
  const testInfo = test.info();
  const { page, projectId } = await setup();
  await invoke(page, 'applicationSettings', {
    ...(await snapshot(page)).settings,
    shell: resolve('tests/fixtures/terminal-wheel.mjs'),
    shellArgs: ['mouse'],
  });
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  await expect(page.locator('.xterm-rows')).toContainText('WHEEL_READY');
  await page.locator('.xterm-helper-textarea').focus();
  await observeWheelPackets();
  const latencies: number[] = [],
    outputLatencies: number[] = [],
    renderLatencies: number[] = [];
  let up = 0,
    down = 0;
  for (let index = 0; index < 110; index++) {
    const delta = index % 2 ? 5 : -5;
    if (delta < 0) up += 5;
    else down += 5;
    const latency = await page.locator('.xterm-screen').evaluate(
      (element, values) =>
        new Promise<{ totalMs: number; outputMs: number; renderMs: number }>((resolve, reject) => {
          const start = performance.now();
          let outputAt = start;
          const stopOutput = (
            window as unknown as {
              blueprint: { onTerminalOutput(callback: () => void): () => void };
            }
          ).blueprint.onTerminalOutput(() => {
            outputAt = performance.now();
          });
          const observer = new MutationObserver(() => {
            if (element.querySelector('.xterm-rows')?.textContent?.includes(values.expected)) {
              observer.disconnect();
              clearTimeout(timeout);
              stopOutput();
              const end = performance.now();
              resolve({
                totalMs: end - start,
                outputMs: outputAt - start,
                renderMs: end - outputAt,
              });
            }
          });
          const timeout = setTimeout(() => {
            observer.disconnect();
            stopOutput();
            reject(new Error('Wheel result was not painted'));
          }, 5000);
          observer.observe(element, { subtree: true, childList: true, characterData: true });
          const rect = element.getBoundingClientRect();
          element.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaY: values.delta,
              deltaMode: 1,
              clientX: rect.x + 40,
              clientY: rect.y + 40,
            }),
          );
        }),
      { delta, expected: `SCROLL_UP=${up} DOWN=${down}` },
    );
    expect(latency.outputMs).toBeGreaterThan(0);
    if (index >= 10) {
      latencies.push(latency.totalMs);
      outputLatencies.push(latency.outputMs);
      renderLatencies.push(latency.renderMs);
    }
  }
  const packets = await wheelPackets();
  expect(packets).toHaveLength(110);
  expect(packets.every((packet) => packet.data.split('\x1b[<').length - 1 === 5)).toBe(true);
  latencies.sort((a, b) => a - b);
  outputLatencies.sort((a, b) => a - b);
  renderLatencies.sort((a, b) => a - b);
  await writeFile(
    testInfo.outputPath('wheel-measurements.json'),
    JSON.stringify(
      {
        environment: 'isolated hidden Electron, real PTY observer TUI',
        warmup: 10,
        actions: 100,
        normalizedRows: 500,
        inputIpcPackets: packets.length - 10,
        p95WheelToPtyOutputMs: outputLatencies[94],
        p95PtyOutputToDomMs: renderLatencies[94],
        p50WheelToDomMs: latencies[49],
        p95WheelToDomMs: latencies[94],
        maxWheelToDomMs: latencies[99],
        latencyBoundary:
          'wheel dispatch to renderer PTY output notification and rendered xterm DOM mutation, not physical screen presentation',
        metrics: await app!.evaluate(({ app }) =>
          app.getAppMetrics().map((metric) => ({
            type: metric.type,
            name: metric.name,
            cpu: metric.cpu,
            memory: metric.memory,
          })),
        ),
      },
      null,
      2,
    ),
  );

  await testInfo.attach('wheel measurements', {
    path: testInfo.outputPath('wheel-measurements.json'),
    contentType: 'application/json',
  });

  await invoke(page, 'applicationSettings', {
    ...(await snapshot(page)).settings,
    shellArgs: ['normal'],
  });
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  const normal = page.locator('.terminal-pane.active');
  await expect(normal.locator('.xterm-rows')).toContainText('WHEEL_READY');
  const before = await normal.locator('.xterm-rows').textContent(),
    count = (await wheelPackets()).length;
  const rect = await normal.locator('.xterm-screen').boundingBox();
  await page.mouse.move(rect!.x + 40, rect!.y + 40);
  await page.mouse.wheel(0, -250);
  await expect(normal.locator('.xterm-rows')).not.toHaveText(before!);
  expect((await wheelPackets()).length).toBe(count);
});

test('wheel fractions reset across mouse mode changes and inactive panes cannot steal input or focus', async () => {
  const { page, projectId } = await setup();
  await invoke(page, 'applicationSettings', {
    ...(await snapshot(page)).settings,
    shell: resolve('tests/fixtures/terminal-wheel.mjs'),
    shellArgs: ['mouse'],
  });
  await command(page, projectId, 'newTerminal', { operationId: randomUUID() });
  const first = page.locator('.terminal-pane').first();
  await expect(first.locator('.xterm-rows')).toContainText('WHEEL_READY');
  await first.locator('.xterm-helper-textarea').focus();
  await observeWheelPackets();
  const wheel = (deltaY: number) =>
    first.locator('.xterm-screen').evaluate((element, deltaY) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: 1,
          deltaY,
          clientX: rect.x + 40,
          clientY: rect.y + 40,
        }),
      );
    }, deltaY);
  const tick = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  await wheel(0.5);
  await first.locator('.xterm-helper-textarea').press('o');
  await expect(first.locator('.xterm-rows')).toContainText('MOUSE_OFF');
  await first.locator('.xterm-helper-textarea').press('i');
  await expect(first.locator('.xterm-rows')).toContainText('MOUSE_ON');
  await wheel(0.5);
  await tick();
  expect((await wheelPackets()).filter((packet) => packet.data.includes('\x1b[<'))).toEqual([]);
  await wheel(0.5);
  await expect(first.locator('.xterm-rows')).toContainText('SCROLL_UP=0 DOWN=1');
  await wheel(0.5);
  await first.locator('.xterm-helper-textarea').press('t');
  await expect(first.locator('.xterm-rows')).toContainText('MOUSE_CYCLE');
  const beforeCycle = (await wheelPackets()).length;
  await wheel(0.5);
  await tick();
  expect((await wheelPackets()).length).toBe(beforeCycle);
  await wheel(0.5);
  await expect(first.locator('.xterm-rows')).toContainText('SCROLL_UP=0 DOWN=2');
  const value = await snapshot(page);
  await command(page, projectId, 'split', {
    axis: 'horizontal',
    paneId: value.workspaces[value.selectedWorkspace!].activePaneId,
    operationId: randomUUID(),
  });
  const second = page.locator('.terminal-pane').nth(1);
  await expect(second.locator('.xterm-rows')).toContainText('WHEEL_READY');
  await second.locator('.xterm-helper-textarea').focus();
  const before = (await wheelPackets()).length;
  await wheel(30);
  await tick();
  expect((await wheelPackets()).length).toBe(before);
  await expect(second).toHaveClass(/active/);
  await expect(second.locator('.xterm-helper-textarea')).toBeFocused();
  await expect(first.locator('.xterm-rows')).toContainText('SCROLL_UP=0 DOWN=2');
});
