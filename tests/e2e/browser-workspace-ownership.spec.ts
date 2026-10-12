import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { paneLeaves, type ApplicationWorkspaceSnapshot } from '../../src/shared/application-workspace';
import { Mcp } from './mcp';

let app: ElectronApplication | undefined, mcp: Mcp | undefined, root: string, server: Server | undefined;
test.afterEach(async () => {
  mcp?.close(); mcp = undefined;
  await app?.close(); app = undefined;
  if (server) await new Promise<void>(done => server!.close(() => done()));
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});
const invoke = <T>(page: Page, name: string, args: Record<string, unknown> = {}) => page.evaluate(
  ({ name, args }) => (window as unknown as { projector: { invoke(name: string, args: Record<string, unknown>): Promise<unknown> } }).projector.invoke(name, args), { name, args },
) as Promise<T>;
const snapshot = (page: Page) => invoke<ApplicationWorkspaceSnapshot>(page, 'applicationSnapshot');
function browserPanes(value: ApplicationWorkspaceSnapshot, key: string) {
  return value.workspaces[key]?.tabs.flatMap(tab => paneLeaves(tab.root))
    .filter(pane => pane.content.kind === 'plan' && pane.content.tab.kind === 'browser') ?? [];
}
function nativeId(pane: ReturnType<typeof browserPanes>[number]): string | undefined {
  return pane.content.kind === 'plan' && pane.content.tab.kind === 'browser' ? pane.content.tab.nativeId : undefined;
}

test('public show_content reuses only its session page and closing another session preserves live form state', async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-browser-workspace-'));
  const data = join(root, 'data'), project = join(root, 'project'), descriptor = join(root, 'endpoint.json');
  await Promise.all([data, project].map(path => mkdir(path)));
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Workspace ownership</title><label>Private form<input id="private-form"></label><button id="guard">Protect unsaved form</button><script>document.querySelector("#guard").onclick=()=>addEventListener("beforeunload",event=>{event.preventDefault();event.returnValue=""})</script>');
  });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const url = `http://127.0.0.1:${address.port}/`;
  app = await electron.launch({ args: [resolve('.')], env: { ...process.env, PROJECTOR_DATA: data, PROJECTOR_RUNTIME_DESCRIPTOR: descriptor } });
  const shell = await app.firstWindow();
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, project);
  await shell.getByRole('button', { name: '+ Open project folder', exact: true }).click();
  const state = await invoke<{ projects: { id: string }[] }>(shell, 'snapshot');
  const projectId = state.projects[0].id;
  mcp = new Mcp(descriptor); await mcp.initialize();
  const artifact = await mcp.tool('create_artifact', {projectId, kind: 'projector', title: 'Agent browser workspace', originSession: {harness: 'codex', sessionId: 'ownership-author'}, operationId: randomUUID()});
  const artifactId = String(artifact.artifactId);
  const select = (sessionId: string) => invoke(shell, 'applicationCommand', { action: 'select', projectId, sessionId });
  const show = () => mcp!.tool('show_content', { artifactId, url });
  const keyA = `${projectId}/ownership-a`, keyB = `${projectId}/ownership-b`;
  await select('ownership-a'); await show();
  await expect.poll(async () => browserPanes(await snapshot(shell), keyA).length).toBe(1);
  const a = browserPanes(await snapshot(shell), keyA)[0];
  await expect.poll(() => app!.context().pages().filter(page => page.url() === url).length).toBe(1);
  const pageA = app.context().pages().find(page => page.url() === url)!;
  await pageA.getByLabel('Private form', { exact: true }).fill('Private A');
  await show();
  await expect.poll(async () => browserPanes(await snapshot(shell), keyA).length).toBe(1);
  expect(nativeId(browserPanes(await snapshot(shell), keyA)[0])).toBe(nativeId(a));
  await expect(pageA.getByLabel('Private form', { exact: true })).toHaveValue('Private A');

  await select('ownership-b'); await show();
  await expect.poll(async () => browserPanes(await snapshot(shell), keyB).length).toBe(1);
  const b = browserPanes(await snapshot(shell), keyB)[0];
  expect(nativeId(b)).not.toBe(nativeId(a));
  await expect.poll(() => app!.context().pages().filter(page => page.url() === url).length).toBe(2);
  const pageB = app.context().pages().find(page => page !== pageA && page.url() === url)!;
  await pageB.getByLabel('Private form', { exact: true }).fill('Private B');
  await pageB.getByRole('button', { name: 'Protect unsaved form', exact: true }).click();
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
  const close = () => invoke<{ closed?: boolean }>(shell, 'applicationCommand', { action: 'closePane', projectId, key: keyB, paneId: b.id });
  expect(await close()).toEqual({ closed: false });
  expect(nativeId(browserPanes(await snapshot(shell), keyB)[0])).toBe(nativeId(b));
  await expect(pageB.getByLabel('Private form', { exact: true })).toHaveValue('Private B');
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; });
  await close();
  expect(pageB.isClosed()).toBe(true);
  expect(pageA.isClosed()).toBe(false);
  await select('ownership-a');
  await invoke(shell, 'applicationCommand', { action: 'focus', projectId, key: keyA, paneId: a.id });
  expect(nativeId(browserPanes(await snapshot(shell), keyA)[0])).toBe(nativeId(a));
  await expect(pageA.getByLabel('Private form', { exact: true })).toHaveValue('Private A');
});
