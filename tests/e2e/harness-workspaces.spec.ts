import { notificationWindow } from './notification-window';
import { expectNewTerminalEnabled, openProjectOverview } from './workspace-ui';
import { test, expect, electron, type ElectronApplication, type Page } from './test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Mcp } from './mcp';
import { paneLeaves, type ApplicationWorkspaceSnapshot } from '../../src/shared/application-workspace';
import type { HarnessSnapshot } from '../../src/shared/harness';
import type { TerminalRecord } from '../../src/shared/terminal';

type Application = ApplicationWorkspaceSnapshot & { terminals: TerminalRecord[]; harnesses: HarnessSnapshot };
let app: ElectronApplication | undefined, root: string, mcp: Mcp | undefined;
test.afterEach(async () => { mcp?.close(); mcp = undefined; await app?.close(); app = undefined; if (root) await rm(root, { recursive: true, force: true }); });
const invoke = <T>(page: Page, name: string, args?: Record<string, unknown>) => page.evaluate(
  ({ name, args }) => (window as unknown as { projector: { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> } }).projector.invoke(name, args), { name, args },
) as Promise<T>;
const snapshot = (page: Page) => invoke<Application>(page, 'applicationSnapshot');

test('owned TUI binds protocol ID, exact Resume and manual saved-state handoff without rewriting authorship', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bp-harness-ui-')));
  const project = join(root, 'project'), other = join(root, 'worktree'), data = join(root, 'data'), home = join(root, 'codex-home');
  await Promise.all([project, other, data, home].map(path => mkdir(path)));
  const descriptor = join(root, 'endpoint.json'), audit = join(root, 'codex.jsonl'), exact = 'exact-product-thread';
  const metadataPath = join(root, 'session-metadata.json');
  const metadata = {
    [exact]: { name: 'Guardian review', source: 'cli' },
    'hidden-review-child': { name: 'Hidden child review', source: { subAgent: 'review' } },
    'hidden-archived-child': { name: 'Hidden archived child', parentThreadId: exact, source: 'cli', archived: true },
  };
  const changeCatalog = async (archived: boolean) => {
    await writeFile(metadataPath + '.tmp', JSON.stringify({ ...metadata, [exact]: { ...metadata[exact], archived } }));
    await rename(metadataPath + '.tmp', metadataPath);
  };
  await changeCatalog(false);
  const launch = () => electron.launch({ args: [resolve('.')], env: { ...process.env,
    PROJECTOR_DATA: data, PROJECTOR_RUNTIME_DESCRIPTOR: descriptor, CODEX_HOME: home,
    CODEX_FIXTURE_PROJECT: project, CODEX_FIXTURE_OTHER_PROJECT: other, CODEX_FIXTURE_AUDIT: audit,
    CODEX_FIXTURE_ID: exact, CODEX_FIXTURE_EMPTY: '0', PROJECTOR_E2E_HARNESS_INTERVAL_MS: '200', CODEX_FIXTURE_MCP_STARTUP_STATUS: 'ready',
    CODEX_FIXTURE_METADATA_FILE: metadataPath } });
  app = await launch();
  let launchErrors = '';
  app.process().stderr?.on('data', chunk => { launchErrors += String(chunk); });
  let page = await app.firstWindow();
  const choose = async (path: string) => {
    await app!.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
    await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
    const state = await invoke<{ projects: { id: string; path: string }[] }>(page, 'snapshot');
    return state.projects.find(p => p.path === path)!.id;
  };
  const projectId = await choose(project), otherId = await choose(other);
  const settings = (await snapshot(page)).settings;
  await invoke(page, 'applicationSettings', { ...settings, codexExecutable: resolve('tests/fixtures/codex-cli.mjs') });
  await expect.poll(async () => (await snapshot(page)).harnesses.sessions.some(session => session.id === exact && session.projectId === projectId)).toBe(true);
  let value = await snapshot(page);
  expect(value.harnesses.sessions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: exact, projectId, processState: 'unknown' }),
    expect.objectContaining({ id: 'other-worktree', projectId: otherId, processState: 'unknown' }),
  ]));
  expect(value.harnesses.sessions.some(session => session.archived)).toBe(false);
  expect(value.terminals).toEqual([]);
  await expect(page.getByRole('button', { name: 'Guardian review', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hidden child review', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Hidden archived child', exact: true })).toHaveCount(0);
  const workspaces = structuredClone(value.workspaces);
  expect(await invoke(page, 'harnessRead', { sessionId: 'hidden-review-child' })).toMatchObject({ isSubAgent: true });
  value = await snapshot(page);
  expect(value.harnesses.sessions.some(session => session.id === 'hidden-review-child')).toBe(false);
  expect(value.workspaces).toEqual(workspaces);
  await changeCatalog(true);
  await expect.poll(async () => (await snapshot(page)).harnesses.sessions.some(session => session.id === exact)).toBe(false);
  await expect(page.getByRole('button', { name: 'Guardian review', exact: true })).toHaveCount(0);
  expect(await invoke(page, 'harnessRead', { sessionId: exact })).toMatchObject({ archived: true });
  expect((await snapshot(page)).harnesses.sessions.some(session => session.id === exact)).toBe(false);
  expect((await snapshot(page)).workspaces).toEqual(workspaces);
  await changeCatalog(false);
  await expect(page.getByRole('button', { name: 'Guardian review', exact: true })).toBeVisible();
  const requests = async () => (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; method?: string; params?: Record<string, unknown>; args?: string[] });
  expect((await requests()).some(event => event.method === 'thread/start' || event.method === 'thread/resume')).toBe(false);
  await page.getByRole('button', { name: 'New Codex session in project', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).terminals.find(record => record.harnessSessionId === exact)?.status).toBe('running').catch(async error => {
    const value = await snapshot(page);
    await test.info().attach('codex-protocol-audit', {path:audit,contentType:'application/x-ndjson'});
    throw new Error(`${String(error)}\nHarness: ${JSON.stringify(value.harnesses)}\nTerminals: ${JSON.stringify(value.terminals)}\n${launchErrors}`);
  });
  await expect.poll(async () => (await snapshot(page)).workspaces[`${projectId}/${exact}`]?.sessionId).toBe(exact);
  value = await snapshot(page);
  const terminal = value.terminals.find(record => record.harnessSessionId === exact)!;
  expect(value.harnesses.sessions.find(session => session.id === exact)).toMatchObject({ rootSessionId: 'root-exact-fixture', terminalId: terminal.id, processState: 'running', status: 'idle' });
  expect(value.harnesses.sessions.find(session => session.id === 'unrelated-background-thread')).toBeUndefined();
  expect((await requests()).filter(event => event.method === 'thread/start' && event.params?.ephemeral === false)).toHaveLength(1);
  await expect.poll(async () => (await snapshot(page)).harnesses.mcpStartup.find(connection => connection.sessionId === exact)?.status).toBe('ready');
  await page.keyboard.press('Meta+,');
  const settingsDialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(settingsDialog).toBeVisible();
  await settingsDialog.getByRole('button', { name: 'Harnesses', exact: true }).click();
  await expect(settingsDialog.getByRole('list', { name: 'Projector MCP startup status' })).toContainText(exact);
  await expect(settingsDialog.getByRole('list', { name: 'Projector MCP startup status' })).toContainText('MCP startup: ready');
  await page.keyboard.press('Escape');
  await expect(settingsDialog).toHaveCount(0);

  mcp = new Mcp(descriptor); await mcp.initialize();
  const author = randomUUID();
  const artifact = await mcp.tool('create_artifact', { projectId, kind: 'projector', title: 'Shared authored plan', originSession: { harness: 'codex', sessionId: author }, operationId: randomUUID() });
  await writeFile(join(String(artifact.sourcePath), 'plan.mdx'), '# Shared authored plan\n\n<TextAnswer id="choice" meaning="Decision" semanticsVersion="1" defaultValue="" />');
  const revision = await mcp.tool('publish_artifact', { artifactId: artifact.artifactId, expectedLatestRevision: null, operationId: randomUUID() });
  // Open in the explicit live session to protect side-by-side plan/terminal behavior.
  await invoke(page, 'applicationCommand', {action: 'openPlan', projectId, key: `${projectId}/${exact}`, artifactId: artifact.artifactId, revisionId: revision.revisionId});
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Shared authored plan' })).toBeVisible();
  expect((await snapshot(page)).workspaces[`${projectId}/${exact}`].tabs[0].root.kind).toBe('split');
  await page.frameLocator('iframe').getByLabel('Decision', { exact: true }).fill('Private before manual Save');
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
  expect(String((await mcp.tool('read_artifact', { artifactId: artifact.artifactId, part: 'state' })).content)).not.toContain('Private before manual Save');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Target Codex session', exact: true })).toBeVisible();
  const saved = await invoke<{ savedStates: { id: string; artifactId: string }[] }>(page, 'snapshot');
  const savedStateId = saved.savedStates.find(state => state.artifactId === artifact.artifactId)!.id;
  expect(String((await mcp.tool('read_artifact', { artifactId: artifact.artifactId, part: 'state', savedStateId })).content)).toContain('Private before manual Save');
  const probe = join(root, 'ipc-probe.cjs');
  await writeFile(probe, 'process.parentPort.on("message",()=>{});');
  await app.evaluate(({ clipboard, utilityProcess }, probe) => {
    clipboard.writeText = async text => { Object.assign(globalThis, { harnessCopiedText: text }); };
    // Count actual terminal writes at the service IPC boundary; clipboard is isolated.
    const child = utilityProcess.fork(probe, [], { stdio: 'ignore' });
    const prototype = Object.getPrototypeOf(child);
    child.kill();
    const original = prototype.postMessage;
    Object.assign(globalThis, { harnessInputCount: 0 });
    prototype.postMessage = function(value: { method?: string }) {
      if (value.method === 'input') (globalThis as unknown as { harnessInputCount: number }).harnessInputCount++;
      return Reflect.apply(original, this, [value]);
    };
  }, probe);
  const assertCopied = async (beforeCopy: number) => {
    await expect.poll(() => app!.evaluate(() =>
      (globalThis as unknown as { harnessCopiedText?: string }).harnessCopiedText ?? '',
    )).toContain(`savedStateId="${savedStateId}"`);
    const copied = await app!.evaluate(() =>
      (globalThis as unknown as { harnessCopiedText: string }).harnessCopiedText,
    );
    expect(copied).toContain(`projectId="${projectId}"`);
    expect(copied).toContain(`artifactId="${artifact.artifactId}"`);
    expect(copied).toContain(`savedStateId="${savedStateId}"`);
    await expect(page.locator('.terminal-pane.active .xterm-helper-textarea')).toBeFocused();
    await expectNewTerminalEnabled(page);
    const current = await snapshot(page);
    expect(current.selectedWorkspace).toBe(`${projectId}/${exact}`);
    const workspace = current.workspaces[current.selectedWorkspace!];
    const active = workspace.tabs.flatMap(tab => paneLeaves(tab.root))
      .find(pane => pane.id === workspace.activePaneId);
    expect(active?.content).toEqual({ kind: 'session', sessionId: exact, terminalId: terminal.id });
    expect(current.terminals).toHaveLength(1);
    await invoke(page, 'terminalScreen', { id: terminal.id });
    expect(await app!.evaluate(() =>
      (globalThis as unknown as { harnessInputCount: number }).harnessInputCount,
    )).toBe(0);
    expect((await requests()).slice(beforeCopy).some(event =>
      event.method === 'turn/start' || event.method === 'thread/resume',
    )).toBe(false);
    expect((await mcp!.tool('read_artifact', {
      artifactId: artifact.artifactId, part: 'manifest',
    })).originSession).toEqual({ harness: 'codex', sessionId: author });
  };
  await page.getByRole('combobox', { name: 'Target Codex session', exact: true }).selectOption(exact);
  let beforeCopy = (await requests()).length;
  await page.locator('.notification').getByRole('button', { name: 'Copy update message', exact: true }).click();
  await assertCopied(beforeCopy);

  // Historical-state copy follows the same UI path from a different workspace;
  // the selected saved state must remain the first one after a newer Save exists.
  await openProjectOverview(page);
  await page.getByRole('button', { name: 'Shared authored plan', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).selectedWorkspace).toBe(`${projectId}/plans`);
  await page.frameLocator('iframe').getByLabel('Decision', { exact: true }).fill('A newer private saved state');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await invoke<{ savedStates: { artifactId: string }[] }>(page, 'snapshot'))
    .savedStates.filter(state => state.artifactId === artifact.artifactId).length).toBe(2);
  const newer = await invoke<{ savedStates: { id: string; artifactId: string }[] }>(page, 'snapshot');
  const states = newer.savedStates.filter(state => state.artifactId === artifact.artifactId);
  expect(states).toHaveLength(2);
  const historicalIndex = states.findIndex(state => state.id === savedStateId);
  expect(historicalIndex).toBeGreaterThanOrEqual(0);
  await page.getByRole('combobox', { name: 'Target Codex session', exact: true }).selectOption(exact);
  const history = page.locator('.package-history').filter({ hasText: 'Saved states' });
  await history.locator('summary').click();
  await invoke(page, 'terminalScreen', { id: terminal.id });
  await app.evaluate(() => {
    Object.assign(globalThis, { harnessCopiedText: '', harnessInputCount: 0 });
  });
  beforeCopy = (await requests()).length;
  await history.getByRole('button', { name: 'Copy update message', exact: true }).nth(historicalIndex).click();
  await assertCopied(beforeCopy);

  await openProjectOverview(page);
  await page.getByRole('button', { name: 'Shared authored plan', exact: true }).click();
  await page.frameLocator('iframe').getByLabel('Decision', { exact: true }).fill('Copy-only saved context');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await invoke<{ savedStates: { artifactId: string }[] }>(page, 'snapshot'))
    .savedStates.filter(state => state.artifactId === artifact.artifactId).length).toBe(3);
  const latest = await invoke<{ savedStates: { id: string; artifactId: string }[] }>(page, 'snapshot');
  const copyOnlyState = latest.savedStates.find(state => state.artifactId === artifact.artifactId &&
    !states.some(previous => previous.id === state.id))!.id;
  await page.getByRole('combobox', { name: 'Target Codex session', exact: true }).selectOption('');
  const beforeCopyOnly = await snapshot(page);
  await invoke(page, 'terminalScreen', { id: terminal.id });
  await app.evaluate(() => {
    Object.assign(globalThis, { harnessCopiedText: '', harnessInputCount: 0 });
  });
  beforeCopy = (await requests()).length;
  await page.locator('.notification').getByRole('button', { name: 'Copy update message', exact: true }).click();
  await expect.poll(() => app!.evaluate(() =>
    (globalThis as unknown as { harnessCopiedText?: string }).harnessCopiedText ?? '',
  )).toContain(`savedStateId="${copyOnlyState}"`);
  await expectNewTerminalEnabled(page);
  const afterCopyOnly = await snapshot(page);
  expect(afterCopyOnly.selectedWorkspace).toBe(beforeCopyOnly.selectedWorkspace);
  expect(afterCopyOnly.workspaces[afterCopyOnly.selectedWorkspace!].activePaneId)
    .toBe(beforeCopyOnly.workspaces[beforeCopyOnly.selectedWorkspace!].activePaneId);
  // Copy-only must release the transition queue so the next real UI action can
  // complete, instead of merely acknowledging clipboard before a reload deadlock.
  await page.getByRole('button', { name: 'Toggle project terminals', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Project terminals', exact: true })).toBeVisible();
  await expectNewTerminalEnabled(page);
  await page.getByRole('button', { name: 'Toggle project terminals', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Project terminals', exact: true })).toHaveCount(0);
  await invoke(page, 'terminalScreen', { id: terminal.id });
  expect(await app.evaluate(() =>
    (globalThis as unknown as { harnessInputCount: number }).harnessInputCount,
  )).toBe(0);
  expect((await requests()).slice(beforeCopy).some(event =>
    event.method === 'turn/start' || event.method === 'thread/resume',
  )).toBe(false);
  expect((await mcp.tool('read_artifact', { artifactId: artifact.artifactId, part: 'manifest' }))
    .originSession).toEqual({ harness: 'codex', sessionId: author });
  expect(revision.revisionId).toBeTruthy();

  mcp.close(); mcp = undefined; await app.close(); app = await launch(); page = await app.firstWindow();
  await expect.poll(async () => (await snapshot(page)).terminals).toEqual([]);
  const afterRestart = await requests();
  expect(afterRestart.filter(event => event.method === 'thread/start' && event.params?.ephemeral === false)).toHaveLength(1);
  expect(afterRestart.filter(event => event.method === 'thread/resume')).toHaveLength(0);
  await invoke(page, 'applicationCommand', { action: 'newCodex', projectId, sessionId: exact, operationId: randomUUID() });
  await expect.poll(async () => (await snapshot(page)).terminals.some(record => record.status === 'running' && record.harnessSessionId === exact)).toBe(true);
  await expect.poll(async () => (await requests()).filter(event => event.method === 'thread/resume').map(event => event.params?.threadId)).toEqual([exact]);
  await expect.poll(async () => (await snapshot(page)).harnesses.sessions.find(session => session.id === exact)?.processState).toBe('running');
});

test('Resume warns about an active writer without starting a terminal or taking over the session', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bp-writer-ui-')));
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home');
  await Promise.all([project, data, home].map(path => mkdir(path)));
  const audit = join(root, 'audit.jsonl'), sessionId = 'busy-session';
  app = await electron.launch({ args: [resolve('.')], env: { ...process.env,
    PROJECTOR_DATA: data, PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 'endpoint.json'), CODEX_HOME: home,
    PROJECTOR_E2E_CODEX_EXECUTABLE: resolve('tests/fixtures/codex-cli.mjs'),
    CODEX_FIXTURE_EMPTY: '0', CODEX_FIXTURE_PROJECT: project, CODEX_FIXTURE_ID: sessionId,
    CODEX_FIXTURE_NAME: 'In use session', CODEX_FIXTURE_ACTIVE_WRITER: sessionId, CODEX_FIXTURE_AUDIT: audit,
  } });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
  await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: 'In use session', exact: true }).click();
  const tab = page.getByRole('tab', { name: 'Codex', exact: true });
  await expect(tab).toBeVisible();
  const before = await snapshot(page);
  const key = before.selectedWorkspace!;
  const pinned = before.workspaces[key].tabs[0];
  expect(paneLeaves(pinned.root)[0].content).toEqual({ kind: 'session', sessionId });
  await expect(page.getByRole('button', { name: 'Close codex tab', exact: true })).toHaveCount(0);
  await tab.click({ button: 'middle' });
  await page.keyboard.press('Meta+w');
  await invoke(page, 'applicationCommand', { action: 'closeTab', projectId: before.workspaces[key].projectId, key, tabId: pinned.id });
  await invoke(page, 'applicationCommand', { action: 'closePane', projectId: before.workspaces[key].projectId, key, paneId: paneLeaves(pinned.root)[0].id });
  expect((await snapshot(page)).workspaces[key].tabs).toEqual(before.workspaces[key].tabs);
  await expect(tab).toBeVisible();
  await page.getByRole('button', {name:'Workspace actions',exact:true}).click();
  await expect(page.getByRole('menuitem', { name: 'Close panel', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  const notices = (await notificationWindow(app!)).locator('.notification-alert');
  const warning = notices.filter({ hasText: 'Session is in use' });
  await expect(warning).toHaveCount(1);
  await expect(warning).toContainText('Continue in the app that has this session open');
  await expect(notices.filter({ hasText: 'Operation failed' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  const state = await snapshot(page);
  expect(state.terminals).toEqual([]);
  expect(state.harnesses.error).toBeNull();
  expect(state.harnesses.mcpStartup).toEqual([]);
  expect(state.harnesses.sessions.find(session => session.id === sessionId)?.processState).toBe('unknown');
  const calls = (await readFile(audit, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { method?: string });
  expect(calls.some(call => call.method === 'thread/start' || call.method === 'thread/resume')).toBe(false);
});
