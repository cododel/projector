import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { paneLeaves, type ApplicationWorkspaceSnapshot } from '../../src/shared/application-workspace';
import { Mcp } from './mcp';

let app: ElectronApplication | undefined;
let mcp: Mcp | undefined;
let root: string;
let server: Server | undefined;
let editorDirectory: string | undefined;

test.afterEach(async () => {
  if (editorDirectory) await chmod(editorDirectory, 0o700);
  mcp?.close();
  mcp = undefined;
  await app?.close();
  app = undefined;
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

async function invoke<T>(page: Page, name: string, args: Record<string, unknown> = {}): Promise<T> {
  return page.evaluate(
    ({ name, args }) =>
      (window as unknown as {
        blueprint: { invoke(name: string, args: Record<string, unknown>): Promise<unknown> };
      }).blueprint.invoke(name, args),
    { name, args },
  ) as Promise<T>;
}
const snapshot = (page: Page) => invoke<ApplicationWorkspaceSnapshot>(page, 'applicationSnapshot');

async function nativeClick(url: string) {
  await app!.evaluate(async ({ webContents }, expectedUrl) => {
    const native = webContents.getAllWebContents().find((contents) => contents.getURL() === expectedUrl)!;
    const point = await native.executeJavaScript(
      '(()=>{const r=document.querySelector("#action").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()',
    );
    native.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    native.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  }, url);
}
async function siteState(url: string): Promise<{ actions: number; focus: string; clicks: boolean[] }> {
  return app!.evaluate(async ({ webContents }, expectedUrl) => {
    const native = webContents.getAllWebContents().find((contents) => contents.getURL() === expectedUrl)!;
    return native.executeJavaScript('({actions:window.actions,focus:document.activeElement?.id||"",clicks:window.clicks})');
  }, url);
}

test('native pane first click drains the sibling comment without acting on the site, including real write failure', async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-native-pane-comment-'));
  const data = join(root, 'data');
  const project = join(root, 'project');
  const descriptor = join(root, 'runtime.json');
  await Promise.all([data, project].map((path) => mkdir(path)));
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><title>Neighbor browser</title><style>body{margin:0}button{position:absolute;top:40px;left:35px;width:160px;height:60px}</style><button id="action" onclick="window.actions++;window.clicks.push(event.isTrusted)">External action</button><script>window.actions=0;window.clicks=[];</script>',
    );
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing local fixture address');
  const url = `http://127.0.0.1:${address.port}/`;
  app = await electron.launch({
    args: [resolve('.')],
    env: { ...process.env, BLUEPRINT_DATA: data, BLUEPRINT_RUNTIME_DESCRIPTOR: descriptor },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, project);
  await page.getByRole('button', { name: '+ Open project folder', exact: true }).click();
  mcp = new Mcp(descriptor);
  await mcp.initialize();
  const context = await mcp.tool('get_blueprint_context', {});
  const projectId = (context.project as { id: string }).id;
  const artifact = await mcp.tool('create_artifact', {
    projectId,
    kind: 'blueprint',
    title: 'Neighbor comment',
    originSession: { harness: 'codex', sessionId: 'native-comment-author' },
    operationId: randomUUID(),
  });
  const artifactId = String(artifact.artifactId);
  await writeFile(join(String(artifact.sourcePath), 'plan.mdx'), '# Neighbor comment\n\nExact annotation target.');
  const revision = await mcp.tool('publish_artifact', {
    artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  });
  const revisionId = String(revision.revisionId);
  await invoke(page, 'applicationCommand', { action: 'select', projectId, sessionId: 'native-comment-view' });
  await mcp.tool('show_content', { artifactId, url });
  await expect(page.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue(url);
  let current = await snapshot(page);
  const key = current.selectedWorkspace!;
  let workspace = current.workspaces[key];
  const browserPane = workspace.tabs.flatMap((tab) => paneLeaves(tab.root))
    .find((pane) => pane.content.kind === 'plan' && pane.content.tab.kind === 'browser')!;
  const command = (action: string, args: Record<string, unknown> = {}) =>
    invoke<ApplicationWorkspaceSnapshot>(page, 'applicationCommand', { action, projectId, key, ...args });
  // The public show operation may have opened a separate document tab. Open it
  // beside the shell through the normal operator API instead of mutating layout data.
  for (const pane of workspace.tabs.flatMap((tab) => paneLeaves(tab.root)))
    if (pane.content.kind === 'plan' && pane.content.tab.kind === 'document')
      await command('closePane', { paneId: pane.id });
  await command('focus', { paneId: browserPane.id });
  await command('split', { paneId: browserPane.id, axis: 'horizontal' });
  current = await snapshot(page);
  workspace = current.workspaces[key];
  const shellPane = paneLeaves(workspace.tabs.find((tab) => tab.id === workspace.activeTabId)!.root)
    .find((pane) => pane.content.kind === 'terminal')!;
  await command('openPlan', { artifactId, revisionId });
  await command('closePane', { paneId: shellPane.id });
  current = await snapshot(page);
  workspace = current.workspaces[key];
  const panes = paneLeaves(workspace.tabs.find((tab) => tab.id === workspace.activeTabId)!.root);
  expect(panes).toHaveLength(2);
  const documentPane = panes.find((pane) => pane.content.kind === 'plan' && pane.content.tab.kind === 'document')!;
  await command('focus', { paneId: documentPane.id });
  // Direct IPC acknowledges the model before the renderer has collapsed the
  // temporary shell split. Select text only in the final two-pane DOM; the
  // intermediate document iframe is remounted by that structural transition.
  const renderedPanes = page.locator('.session-workspace-content .workspace-pane');
  await expect(renderedPanes).toHaveCount(2);
  await expect(page.locator('.session-workspace-content .workspace-split')).toHaveCount(1);
  await expect(page.locator(`[data-workspace-pane="${documentPane.id}"]`)).toHaveClass(/\bactive\b/);
  await expect(page.locator(`[data-workspace-pane="${browserPane.id}"]`)).toHaveCount(1);
  const frame = page.frameLocator(`iframe[data-pane-id="${documentPane.id}"][src*="artifactId=${artifactId}"]`);
  const paragraph = frame.locator('p').filter({ hasText: 'Exact annotation target.' });
  await expect(paragraph).toBeVisible();
  await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await frame.getByRole('button', { name: 'Annotate', exact: true }).click();
  const editor = frame.getByLabel('Annotation comment', { exact: true });
  await editor.fill('Confirmed private draft');
  const editorPath = join(data, 'editors', artifactId, revisionId + '.json');
  await expect.poll(async () => JSON.parse(await readFile(editorPath, 'utf8')).comment)
    .toBe('Confirmed private draft');
  editorDirectory = join(data, 'editors', artifactId);
  await chmod(editorDirectory, 0o500);
  // This is an actual private-storage failure, not a stubbed IPC response.
  await expect(writeFile(join(editorDirectory, 'permission-probe'), 'must fail')).rejects
    .toMatchObject({ code: 'EACCES' });
  await editor.fill('Private text after write failure');
  await expect(frame.getByRole('alert')).toContainText('EACCES');
  const beforeSite = await siteState(url);
  await nativeClick(url);
  await expect(page.locator('.error-banner').filter({ hasText: 'Local save failed. Retry or cancel before leaving.' }))
    .toBeVisible();
  expect((await snapshot(page)).workspaces[key].activePaneId).toBe(documentPane.id);
  await expect(editor).toHaveValue('Private text after write failure');
  expect(await siteState(url)).toEqual(beforeSite);
  expect((await snapshot(page)).selectedWorkspace).toBe(key);
  expect(await mcp.tool('read_artifact', { artifactId, part: 'state' }))
    .toMatchObject({ savedState: null, privateStateIncluded: false });
  expect(JSON.parse(await readFile(editorPath, 'utf8')).comment).toBe('Confirmed private draft');

  await chmod(editorDirectory, 0o700);
  await editor.fill('Confirmed after storage recovery');
  await expect.poll(async () => JSON.parse(await readFile(editorPath, 'utf8')).comment)
    .toBe('Confirmed after storage recovery');
  await nativeClick(url);
  await expect.poll(async () => (await snapshot(page)).workspaces[key].activePaneId).toBe(browserPane.id);
  await expect(editor).toHaveCount(0);
  await expect(page.locator('.annotation p')).toContainText('Confirmed after storage recovery');
  expect(await siteState(url)).toEqual(beforeSite);
  // No deferred replay. Once activation has succeeded, the next operator click
  // reaches the actual page with the regular trusted native event.
  await nativeClick(url);
  await expect.poll(() => siteState(url)).toEqual({ actions: 1, focus: 'action', clicks: [true] });
  expect(await mcp.tool('read_artifact', { artifactId, part: 'state' }))
    .toMatchObject({ savedState: null, privateStateIncluded: false });
});
