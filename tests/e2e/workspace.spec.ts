import { newBrowserTab } from './workspace-ui';
import {
  test,
  expect,
  electron,
  type ElectronApplication,
  type Page,
  type Locator,
} from './test';
import { mkdtemp, mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Mcp } from './mcp';
import {
  paneLeaves,
  type ApplicationWorkspaceSnapshot,
} from '../../src/shared/application-workspace';
let app: ElectronApplication, root: string, server: Server | undefined, mcp: Mcp | undefined;
test.afterEach(async () => {
  mcp?.close();
  mcp = undefined;
  await app?.close();
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});
async function choose(page: Page, path: string) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, path);
  await page.getByRole('button', { name: '+ Open project folder' }).click();
}
async function applicationSnapshot(page: Page): Promise<ApplicationWorkspaceSnapshot> {
  return page.evaluate(() =>
    (
      window as unknown as {
        projector: { invoke(name: string): Promise<ApplicationWorkspaceSnapshot> };
      }
    ).projector.invoke('applicationSnapshot'),
  );
}
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Workspace tabs' }).getByRole('tab');
async function planTab(
  page: Page,
  artifactId: unknown,
  kind: 'document' | 'home' | 'browser',
): Promise<Locator> {
  await expect
    .poll(async () => {
      const value = await applicationSnapshot(page),
        current = value.selectedWorkspace ? value.workspaces[value.selectedWorkspace] : null;
      return (
        current?.tabs.findIndex((tab) =>
          paneLeaves(tab.root).some(
            (pane) =>
              pane.content.kind === 'plan' &&
              pane.content.artifactId === artifactId &&
              pane.content.tab.kind === kind,
          ),
        ) ?? -1
      );
    })
    .toBeGreaterThanOrEqual(0);
  const value = await applicationSnapshot(page),
    current = value.workspaces[value.selectedWorkspace!];
  const index = current.tabs.findIndex((tab) =>
    paneLeaves(tab.root).some(
      (pane) =>
        pane.content.kind === 'plan' &&
        pane.content.artifactId === artifactId &&
        pane.content.tab.kind === kind,
    ),
  );
  if (index < 0) throw new Error(`Missing ${kind} tab for requested artifact.`);
  await expect(tabs(page)).toHaveCount(current.tabs.length);
  return tabs(page).nth(index);
}
test('project Plans workspaces, local comments, browser close and restart preserve independent artifact work', async ({ diagnostics }) => {
  root = await mkdtemp(join(tmpdir(), 'bp-workspace-'));
  const data = join(root, 'data'),
    project = join(root, 'project'),
    otherProject = join(root, 'other');
  await Promise.all([data, project, otherProject].map((path) => mkdir(path)));
  const launch = () =>
    electron.launch({
      args: [resolve('.')],
      env: {
        ...process.env,
        PROJECTOR_DATA: data,
        PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 's.sock'),
      },
    });
  app = await launch();
  let page = await app.firstWindow();
  await choose(page, project);
  mcp = new Mcp(join(root, 's.sock'));
  await mcp.initialize();
  async function create(title: string, session: string) {
    const context = await mcp!.tool('get_projector_context', {});
    const artifact = await mcp!.tool('create_artifact', {
      projectId: (context.project as { id: string }).id,
      kind: 'projector',
      title,
      originSession: { harness: 'codex', sessionId: session },
      operationId: randomUUID(),
    });
    await writeFile(
      join(String(artifact.sourcePath), 'plan.mdx'),
      `# ${title}\n\nExact selected phrase.\n\n<TextAnswer id="answer" meaning="Decision" semanticsVersion="1" defaultValue="" />`,
    );
    const revision = await mcp!.tool('publish_artifact', {
      artifactId: artifact.artifactId,
      expectedLatestRevision: null,
      operationId: randomUUID(),
    });
    return { artifact, revision };
  }
  const a = await create('First plan', 'session-one'),
    b = await create('Second plan', 'session-two');
  await writeFile(
    join(String(a.artifact.sourcePath), 'plan.mdx'),
    '# First plan\n\nExact selected phrase.\n\n<TextAnswer id="answer" meaning="Decision" semanticsVersion="1" defaultValue="" />\n\n## Alternative revision',
  );
  await mcp.tool('publish_artifact', {
    artifactId: a.artifact.artifactId,
    expectedLatestRevision: a.revision.revisionId,
    operationId: randomUUID(),
  });
  await choose(page, otherProject);
  const c = await create('Third plan', 'session-three');
  await mcp.tool('show_artifact', {
    artifactId: a.artifact.artifactId,
    revisionId: a.revision.revisionId,
  });
  let frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'First plan' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Document version' })).toHaveValue(
    String(a.revision.revisionId),
  );
  await expect(page.getByRole('button', { name: /Open Codex session for/ })).toHaveCount(0);
  await expect(frame.getByRole('heading', { name: 'First plan' })).toBeVisible();
  await frame.getByLabel('Decision', { exact: true }).fill('Private answer');
  await frame
    .locator('p')
    .filter({ hasText: 'Exact selected phrase.' })
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
  await frame.getByRole('button', { name: 'Annotate', exact: true }).click();
  await frame.getByLabel('Annotation comment', { exact: true }).fill('Private annotation');
  // Tab transition finalizes the editor, waits for private persistence, and never publishes.
  await newBrowserTab(page);
  await expect(page.getByRole('textbox', { name: 'New tab address' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveCount(0);
  await expect(page.locator('.annotation p')).toContainText('Private annotation');
  expect(
    String(
      (await mcp.tool('read_artifact', { artifactId: a.artifact.artifactId, part: 'state' }))
        .content,
    ),
  ).not.toContain('Private annotation');
  await page
    .getByRole('textbox', { name: 'New tab address' })
    .fill('https://example.test/unfinished');
  await page.getByRole('button', { name: 'Open project project', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'Second plan', exact: true }).click();
  // Standalone Plans now shares one tabstrip per project. Artifact state stays independent.
  await expect(tabs(page)).toHaveCount(3);
  await newBrowserTab(page);
  await page.getByRole('textbox', { name: 'New tab address' }).fill('https://example.test/second');
  await page.getByRole('button', { name: 'Open project other', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'Third plan', exact: true }).click();
  await expect(tabs(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Open project project', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'First plan', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'First plan', exact: true })).toBeVisible();
  await expect(frame.getByLabel('Decision', { exact: true })).toHaveValue('Private answer');
  await (await planTab(page, a.artifact.artifactId, 'home')).click();
  await expect(page.getByRole('textbox', { name: 'New tab address' })).toHaveValue(
    'https://example.test/unfinished',
  );
  server = createServer((_req, res) =>
    res.end('<title>Local browser page</title><input id="edit" />'),
  );
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw Error('Missing server');
  const url = `http://127.0.0.1:${address.port}`;
  await page.getByRole('textbox', { name: 'New tab address' }).fill(url);
  await page.getByRole('textbox', { name: 'New tab address' }).press('Enter');
  await expect(tabs(page)).toHaveCount(4);
  await expect(page.getByRole('tab', { name: 'New tab', exact: true })).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveValue(url + '/');
  await expect(page.getByRole('tab', { name: 'Local browser page', exact: true })).toBeVisible();
  const toolbar = page.locator('.plan-header');
  await expect(toolbar.getByRole('textbox', { name: 'Browser address' })).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 700));
  for (const [left, right] of [
    [true, true],
    [false, true],
    [false, false],
    [true, false],
  ]) {
    for (const [side, visible] of [
      ['projects', left],
      ['feedback', right],
    ] as const) {
      const toggle = page.getByRole('button', {
        name: `${visible ? 'Show' : 'Hide'} ${side} sidebar`,
      });
      if (await toggle.count()) await toggle.click();
    }
    await expect(page.locator('.app')).not.toHaveClass(/sidebar-animating/);
    const top = page.locator('.titlebar-center');
    const topBounds = (await top.boundingBox())!;
    const contentBounds = (await page.locator('.workspace').boundingBox())!;
    expect(topBounds.x).toBeCloseTo(contentBounds.x, 0);
    expect(topBounds.width).toBeCloseTo(contentBounds.width, 0);
    await expect(page.locator('.titlebar-left')).toHaveCount(left ? 1 : 0);
    await expect(page.locator('.titlebar-right')).toHaveCount(right ? 1 : 0);
    await expect(page.locator('.sidebar .brand')).toHaveCount(0);
    const branding = page.locator('.titlebar-brand');
    await expect(branding).toHaveCount(left ? 1 : 0);
    if (left) {
      await expect(branding).toHaveText('PProjector');
      const brand = (await branding.boundingBox())!;
      const toggle = (await page.getByRole('button', { name: 'Hide projects sidebar' }).boundingBox())!;
      expect(brand.x).toBeGreaterThanOrEqual(82);
      expect(brand.x + brand.width).toBeLessThanOrEqual(toggle.x);
      expect(await branding.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('drag');
    }

    const bounds = await toolbar.boundingBox();
    for (const name of [
      'Document version',
      'Browser zoom',
      'Browser address',
      'Annotate browser',
    ]) {
      const control = toolbar.getByLabel(name, { exact: true });
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(bounds!.y);
      expect(box!.y + box!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
      expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    }
    expect(
      await toolbar.getByLabel('Browser address').evaluate((el) => el.clientWidth),
    ).toBeGreaterThan(45);
    expect(
      await toolbar
        .getByLabel('Annotate browser')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `.tmp/tasks/harness-workspaces-20261011/pty-gate/browser-toolbar-${left}-${right}.png`,
    });
  }
  await page.getByRole('button', { name: 'Show feedback sidebar' }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 900));
  await page.getByRole('button', { name: 'MCP connection', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'MCP connection' })).toBeVisible();
  await page.locator('.modal-backdrop').click({ position: { x: 350, y: 70 } });
  await expect(page.getByRole('dialog', { name: 'MCP connection' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'MCP connection', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Local browser page', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const resize = page.getByRole('separator', { name: 'Resize feedback sidebar' });
  const resizeBounds = (await resize.boundingBox())!;
  await page.mouse.move(resizeBounds.x + 3, resizeBounds.y + 150);
  await page.mouse.down();
  await expect(page.locator('.sidebar-resize-shield')).toBeVisible();
  await page.mouse.move(resizeBounds.x - 87, resizeBounds.y + 150, { steps: 5 });
  await page.mouse.up();
  await expect(resize).toHaveAttribute('aria-valuenow', '400');
  await expect(page.locator('.sidebar-resize-shield')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Local browser page', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await resize.dblclick();
  await expect(resize).toHaveAttribute('aria-valuenow', '310');
  await expect(page.locator('.app')).not.toHaveClass(/sidebar-animating/);
  const dragBounds = (await resize.boundingBox())!;
  const dragX = dragBounds.x + 3;
  const dragY = dragBounds.y + 150;
  await page.mouse.move(dragX, dragY);
  await page.mouse.down();
  await page.mouse.move(dragX + 134, dragY, { steps: 4 }); // 176: still at minimum
  await expect(page.locator('.feedback-panel')).toBeVisible();
  await page.mouse.move(dragX + 136, dragY); // 174: collapse while still holding
  const rightEdgeOffsets = await page.locator('.app').evaluate(async (el) => {
    const offsets: number[] = [];
    while (el.classList.contains('sidebar-animating')) {
      const handle = el
        .querySelector('[aria-label="Resize feedback sidebar"]')!
        .getBoundingClientRect();
      const panel = el.querySelector('.feedback-viewport')!.getBoundingClientRect();
      offsets.push(Math.abs(handle.x + handle.width / 2 - panel.left));
      await new Promise(requestAnimationFrame);
    }
    return offsets;
  });
  expect(rightEdgeOffsets.length).toBeGreaterThan(0);
  expect(Math.max(...rightEdgeOffsets)).toBeLessThan(1);
  await expect(page.getByRole('button', { name: 'Show feedback sidebar' })).toBeVisible();
  await expect(page.locator('.feedback-panel')).toBeHidden();
  await expect(page.locator('.sidebar-resize-shield')).toBeVisible();
  await page.mouse.move(dragX + 50, dragY, { steps: 4 }); // 260: restore in same drag
  await expect(page.locator('.feedback-panel')).toBeVisible();
  await page.mouse.up();
  await expect(resize).toHaveAttribute('aria-valuenow', '260');
  const collapseBounds = (await resize.boundingBox())!;
  await page.mouse.move(collapseBounds.x + 3, dragY);
  await page.mouse.down();
  await page.mouse.move(collapseBounds.x + 90, dragY, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('.sidebar-resize-shield')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show feedback sidebar' })).toBeVisible();
  await page.getByRole('button', { name: 'Show feedback sidebar' }).click();
  await expect(resize).toHaveAttribute('aria-valuenow', '260');

  await app.evaluate(async ({ webContents, dialog }, url) => {
    const contents = webContents.getAllWebContents().find((c) => c.getURL() === url + '/')!;
    await contents.executeJavaScript('window.onbeforeunload=()=>true;void 0', true);
    Object.assign(globalThis, { workspaceClosePrompts: 0 });
    dialog.showMessageBoxSync = () => {
      (globalThis as unknown as { workspaceClosePrompts: number }).workspaceClosePrompts++;
      return 1;
    };
  }, url);
  await page
    .getByRole('tab', { name: 'Local browser page', exact: true })
    .click({ button: 'middle' });
  await expect
    .poll(() =>
      app.evaluate(
        () => (globalThis as unknown as { workspaceClosePrompts: number }).workspaceClosePrompts,
      ),
    )
    .toBe(1);
  await expect(
    page.getByRole('button', { name: 'Close local browser page tab', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('tab', { name: 'Local browser page', exact: true })).toBeVisible();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 0;
  });
  const previousView = await applicationSnapshot(page);
  const previousWorkspace = previousView.workspaces[previousView.selectedWorkspace!];
  const previousTab = previousWorkspace.tabs.find(tab => tab.id === previousWorkspace.activeTabId)!;
  const previousPanes = paneLeaves(previousTab.root);
  const oldBrowserPane = previousPanes.find(pane => pane.content.kind === 'plan' && pane.content.tab.kind === 'browser')!;
  await page.getByRole('button', { name: 'Close local browser page tab', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Local browser page', exact: true })).toHaveCount(0);
  const staleProjection = await page.evaluate(owner => (window as unknown as {projector:{invoke(name:string,args:unknown):Promise<unknown>}}).projector.invoke('browserViews', owner), {
    workspaceKey: previousView.selectedWorkspace!, tabId: previousTab.id, paneIds: previousPanes.map(pane => pane.id),
    views: [{viewId: oldBrowserPane.id, active:true, bounds:{x:0,y:40,width:100,height:100}}],
  });
  expect(staleProjection).toEqual({updated:false,reason:'view-changed'});

  // Closing this artifact's document retains its private work and leaves the
  // other artifact's document/home tabs intact in the shared project workspace.
  await (await planTab(page, a.artifact.artifactId, 'document')).click({ button: 'middle' });
  await expect(tabs(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Open project project', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'First plan', exact: true }).click();
  await expect(frame.getByLabel('Decision', { exact: true })).toHaveValue('Private answer');
  await expect(page.locator('.annotation p')).toContainText('Private annotation');
  // The other project's only tab exercises last-tab closure without deleting
  // the first project's preserved Second plan home workspace.
  await page.getByRole('button', { name: 'Open project other', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'Third plan', exact: true }).click();
  await (await planTab(page, c.artifact.artifactId, 'document')).click({ button: 'middle' });
  await expect(page.getByRole('heading', { name: 'No open tabs' })).toBeVisible();
  await page.getByRole('button', { name: 'Open plan', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Third plan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close plan tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open project project', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'Second plan', exact: true }).click();
  await page.getByRole('button', { name: 'Open project project', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'First plan', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Document version' })).toHaveValue(
    String(a.revision.revisionId),
  );
  // Leave a browser URL persisted but no live browser will load on restart.
  await mcp.tool('show_content', { artifactId: b.artifact.artifactId, url });
  await page.getByRole('button', { name: 'Open project project', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'Second plan', exact: true }).click();
  await page.getByRole('tab', { name: 'Local browser page', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveValue(url + '/');
  await page.screenshot({
    path: resolve('.tmp/tasks/harness-workspaces-20261011/pty-gate/browser.png'),
  });
  // Restoration is lazy for an unselected browser tab. A selected browser is
  // expected to restore when its visible pane mounts, so leave a document active.
  await (await planTab(page, b.artifact.artifactId, 'document')).click();
  await expect(frame.getByRole('heading', { name: 'Second plan', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveCount(0);
  const beforeRestart = await applicationSnapshot(page);
  const savedTabIds = beforeRestart.workspaces[beforeRestart.selectedWorkspace!].tabs.map(
    (tab) => tab.id,
  );
  mcp.close();
  mcp = undefined;
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  frame = page.frameLocator('iframe');
  await expect(page.getByRole('separator', { name: 'Resize feedback sidebar' })).toHaveAttribute(
    'aria-valuenow',
    '260',
  );
  await page.getByRole('button', { name: 'Open project project', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'Second plan', exact: true }).click();
  await expect(tabs(page)).toHaveCount(4);
  const afterRestart = await applicationSnapshot(page);
  expect(
    afterRestart.workspaces[afterRestart.selectedWorkspace!].tabs.map((tab) => tab.id),
  ).toEqual(savedTabIds);
  await expect
    .poll(() =>
      app.evaluate(
        ({ webContents }) =>
          webContents.getAllWebContents().filter((c) => c.getURL().startsWith('http://127.0.0.1'))
            .length,
      ),
    )
    .toBe(0);
  await (await planTab(page, b.artifact.artifactId, 'home')).click();
  await expect(page.getByRole('textbox', { name: 'New tab address' })).toHaveValue(
    'https://example.test/second',
  );
  await page.getByRole('tab', { name: 'Local browser page', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveValue(url + '/');
  await page.getByRole('button', { name: 'Open project project', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'First plan', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'First plan', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(frame.getByLabel('Decision', { exact: true })).toHaveValue('Private answer');
  await expect(page.locator('.annotation p')).toContainText('Private annotation');
  await expect(page.getByText('VISUAL PLANNING')).toHaveCount(0);
  await page.screenshot({
    path: resolve('.tmp/tasks/harness-workspaces-20261011/pty-gate/document.png'),
  });
  await page.getByRole('button', { name: 'Edit annotation 1', exact: true }).click();
  await page.getByLabel('Edit annotation', { exact: true }).fill('Edited private annotation');
  await page.getByRole('button', { name: 'Open project project', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'Second plan', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Second plan', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open project project', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'First plan', exact: true }).click();
  await expect(page.locator('.annotation p')).toContainText('Edited private annotation');
  await expect(page.getByRole('combobox', { name: 'Document version' })).toHaveValue(
    String(a.revision.revisionId),
  );
  // Fail one private annotation write at the runtime transport boundary. The
  // transition must retain the editor; retry then persists exactly one comment.
  await frame
    .locator('p')
    .filter({ hasText: 'Exact selected phrase.' })
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
  await frame.getByRole('button', { name: 'Annotate', exact: true }).click();
  await frame.getByLabel('Annotation comment', { exact: true }).fill('Retry this comment');
  await expect(page.getByText('Saved locally')).toBeVisible();
  const probeFile = join(root, 'annotation-fault-probe.cjs');
  await writeFile(probeFile, 'process.parentPort.on("message",()=>{});');
  diagnostics.phase('annotation-write-failure');
  diagnostics.expect({ role: 'main', kind: 'console-error', phase: 'annotation-write-failure', message: /^Error occurred in handler for 'projector:invoke': Error: DISK_WRITE_FAILED: Injected isolated write failure\n[\s\S]*$/, count: 1 });
  const tabsBeforeFailedWrite = await tabs(page).count();
  await app.evaluate(({ utilityProcess }, file) => {
    const probe = utilityProcess.fork(file, [], { stdio: 'ignore' });
    const prototype = Object.getPrototypeOf(probe);
    probe.kill();
    const original = prototype.postMessage;
    Object.assign(globalThis, { workspaceAnnotationFaults: 0 });
    prototype.postMessage = function (
      request: { id?: string; type?: string; name?: string },
      transfer?: Electron.MessagePortMain[],
    ) {
      if (request.type === 'operator' && request.name === 'addAnnotation') {
        prototype.postMessage = original;
        (globalThis as unknown as { workspaceAnnotationFaults: number })
          .workspaceAnnotationFaults++;
        // Fail before forwarding the mutation, matching a known failed write.
        // Sending then losing the reply would be UNKNOWN_RESULT, a separate oracle.
        queueMicrotask(() =>
          this.emit('message', {
            type: 'operator-response',
            id: request.id,
            error: { code: 'DISK_WRITE_FAILED', message: 'Injected isolated write failure' },
          }),
        );
        return;
      }
      return Reflect.apply(original, this, [request, transfer]);
    };
  }, probeFile);
  await newBrowserTab(page);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(frame.getByLabel('Annotation comment', { exact: true })).toHaveValue(
    'Retry this comment',
  );
  await expect(tabs(page)).toHaveCount(tabsBeforeFailedWrite);
  expect(
    await app.evaluate(
      () =>
        (globalThis as unknown as { workspaceAnnotationFaults: number }).workspaceAnnotationFaults,
    ),
  ).toBe(1);
  diagnostics.phase('test');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'New tab address' })).toBeVisible();
  await expect(page.locator('.annotation p').filter({ hasText: 'Retry this comment' })).toHaveCount(
    1,
  );
  // A failed workspace write must be detected before a live site's view closes.
  await page.getByRole('button', { name: 'Open project project', exact: true }).click();
  await expect(page.locator('.project-dashboard')).toBeVisible();
  await page.getByRole('button', { name: 'Second plan', exact: true }).click();
  await page.getByRole('tab', { name: 'Local browser page', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Close local browser page tab', exact: true }),
  ).toBeEnabled();
  const metadata = join(data, 'application-workspace.json'),
    backup = join(root, 'application-workspace.backup.json');
  await rename(metadata, backup);
  await mkdir(metadata);
  diagnostics.phase('workspace-write-failure');
  diagnostics.expect({ role: 'main', kind: 'console-error', phase: 'workspace-write-failure', message: /^Error occurred in handler for 'projector:invoke': Error: EISDIR: illegal operation on a directory, rename '[^\n]*application-workspace\.json\.[^\n]*\.tmp' -> '[^\n]*application-workspace\.json'\n[\s\S]*$/, count: 1 });
  await page
    .getByRole('tab', { name: 'Local browser page', exact: true })
    .click({ button: 'middle' });
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Local browser page', exact: true })).toBeVisible();
  expect(
    await app.evaluate(
      ({ webContents }, url) =>
        webContents.getAllWebContents().filter((c) => c.getURL() === url + '/').length,
      url,
    ),
  ).toBe(1);
  diagnostics.phase('test');
  await rm(metadata, { recursive: true });
  await rename(backup, metadata);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Local browser page', exact: true })).toHaveCount(0);
  expect(c.artifact.artifactId).not.toBe(a.artifact.artifactId);
});
