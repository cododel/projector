import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { paneLeaves, type ApplicationWorkspaceSnapshot } from '../../src/shared/application-workspace';
import type { TerminalRecord } from '../../src/shared/terminal';

let app: ElectronApplication | undefined, root: string;
test.afterEach(async () => {
  await app?.close(); app = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});
type Application = ApplicationWorkspaceSnapshot & { terminals: TerminalRecord[] };
const invoke = <T>(page: Page, name: string, args: Record<string, unknown> = {}) => page.evaluate(
  ({ name, args }) => (window as unknown as { blueprint: { invoke(name: string, args: Record<string, unknown>): Promise<unknown> } }).blueprint.invoke(name, args), { name, args },
) as Promise<T>;
const snapshot = (page: Page) => invoke<Application>(page, 'applicationSnapshot');

test('removing a project deselects its workspace while preserving layouts and live processes for explicit registration', async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-removed-workspace-'));
  const data = join(root, 'data'), project = join(root, 'project');
  await Promise.all([data, project].map(path => mkdir(path)));
  const launch = () => electron.launch({ args: [resolve('.')], env: { ...process.env,
    BLUEPRINT_DATA: data, BLUEPRINT_RUNTIME_DESCRIPTOR: join(root, 'endpoint.json') } });
  app = await launch(); let page = await app.firstWindow();
  const register = async () => {
    await app!.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, project);
    await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
    return invoke<{ projects: { id: string }[] }>(page, 'snapshot');
  };
  const projectId = (await register()).projects[0].id;
  const command = (action: string, params: Record<string, unknown> = {}) => invoke(page, 'applicationCommand', { action, projectId, ...params });
  await command('newTerminal', { operationId: randomUUID() });
  let value = await snapshot(page); const key = value.selectedWorkspace!;
  const firstPane = paneLeaves(value.workspaces[key].tabs[0].root)[0];
  await command('split', { key, paneId: firstPane.id, axis: 'vertical', operationId: randomUUID() });
  value = await snapshot(page);
  await command('ratio', { key, paneId: value.workspaces[key].tabs[0].root.id, ratio: 0.63 });
  await command('newTerminal', { key, area: 'bottom', operationId: randomUUID() });
  await command('bottomHeight', { key, height: 333 });
  const before = await snapshot(page);
  const pids = before.terminals.map(record => record.pid);
  expect(before.terminals).toHaveLength(3);
  expect(before.terminals.every(record => record.status === 'running' && record.pid)).toBe(true);
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  await invoke(page, 'removeProject', { projectId });
  const removed = await snapshot(page);
  expect((await invoke<{ projects: unknown[] }>(page, 'snapshot')).projects).toEqual([]);
  expect(removed.selectedWorkspace).toBeNull();
  expect(removed.workspaces[key]).toEqual(before.workspaces[key]);
  expect(removed.bottom[projectId]).toEqual(before.bottom[projectId]);
  expect(removed.terminals.map(record => record.pid)).toEqual(pids);
  expect(removed.terminals.every(record => record.status === 'running')).toBe(true);

  expect((await register()).projects[0].id).toBe(projectId);
  const registered = await snapshot(page);
  expect(registered.selectedWorkspace).toBe(key);
  expect(registered.workspaces[key]).toEqual(before.workspaces[key]);
  expect(registered.bottom[projectId]).toEqual(before.bottom[projectId]);
  expect(registered.terminals.map(record => record.pid)).toEqual(pids);
  await invoke(page, 'removeProject', { projectId });
  await app.close(); app = undefined;
  // Old application data may still contain a selected workspace whose project
  // was removed through an older runtime. Repair selection, not its saved layout.
  const metadataPath = join(data, 'application-workspace.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as ApplicationWorkspaceSnapshot;
  metadata.selectedWorkspace = key;
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  app = await launch(); page = await app.firstWindow();
  const restored = await snapshot(page);
  expect(restored.selectedWorkspace).toBeNull();
  expect(restored.workspaces[key]).toEqual(before.workspaces[key]);
  expect(restored.bottom[projectId]).toEqual(before.bottom[projectId]);
  expect(restored.terminals.every(record => record.status === 'inactive' && record.pid === undefined)).toBe(true);
  expect((await register()).projects[0].id).toBe(projectId);
  const reopened = await snapshot(page);
  expect(reopened.selectedWorkspace).toBe(key);
  expect(reopened.workspaces[key]).toEqual(before.workspaces[key]);
  expect(reopened.bottom[projectId]).toEqual(before.bottom[projectId]);
  expect(reopened.terminals.every(record => record.status === 'inactive')).toBe(true);
});
