import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Mcp } from './mcp';
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
// Hidden checks exercise real Menu templates and actions without activating an OS menu.
// Native presentation/focus is verified separately in the visible acceptance run.
async function interceptMenus() {
  await app.evaluate(({ Menu }) => {
    process.env.BP_TEST_MENU = '';
    Menu.prototype.popup = function (options) {
      process.env.BP_TEST_MENU = JSON.stringify(
        this.items.map((item) => ({ label: item.label, type: item.type, enabled: item.enabled })),
      );
      const item = this.items.find(
        (candidate) => candidate.label === process.env.BP_TEST_MENU_ACTION,
      );
      process.env.BP_TEST_MENU_ACTION = '';
      if (item?.enabled) item.click();
      options?.callback?.();
    };
  });
}
async function menuAction(label: string) {
  await app.evaluate((_electron, action) => {
    process.env.BP_TEST_MENU = '';
    process.env.BP_TEST_MENU_ACTION = action;
  }, label);
}
async function menuItems() {
  await expect.poll(() => app.evaluate(() => process.env.BP_TEST_MENU ?? '')).not.toBe('');
  return app.evaluate(
    () =>
      JSON.parse(process.env.BP_TEST_MENU ?? '[]') as {
        label: string;
        type: string;
        enabled: boolean;
      }[],
  );
}
test('agent-created unpublished plan has native project actions and retains private browser capture through first publication', async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-empty-ui-'));
  const data = join(root, 'data'),
    project = join(root, 'project'),
    socket = join(root, 's.sock');
  await Promise.all([data, project].map((path) => mkdir(path)));
  const launch = () =>
    electron.launch({
      args: [resolve('.')],
      env: { ...process.env, BLUEPRINT_DATA: data, BLUEPRINT_RUNTIME_DESCRIPTOR: socket },
    });
  app = await launch();
  let page = await app.firstWindow();
  await choose(page, project);
  await interceptMenus();
  const folder = page.getByRole('button', {name: 'Open project project', exact: true});
  const toggle = page.locator('.project-toggle').first();
  const expanded = await toggle.getAttribute('aria-expanded');
  await page.getByRole('button', { name: 'Project actions for project', exact: true }).click();
  const dotsMenu = await menuItems();
  expect(dotsMenu.map((item) => item.label)).toEqual(['New session', '', 'Remove from list']);
  await menuAction('');
  await folder.click({ button: 'right' });
  expect(await menuItems()).toEqual(dotsMenu);
  await folder.focus();
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Project actions for project', exact: true }),
  ).toBeFocused();
  await expect(page.locator('.project-row-actions')).toHaveCSS('opacity', '1');
  await menuAction('');
  await page.keyboard.press('Enter');
  expect(await menuItems()).toEqual(dotsMenu);
  expect(await toggle.getAttribute('aria-expanded')).toBe(expanded);
  await expect(page.getByRole('button', { name: 'Remove from list', exact: true })).toHaveCount(0);
  mcp = new Mcp(socket);
  await mcp.initialize();
  const context = await mcp.tool('get_blueprint_context', {});
  const projectId = (context.project as {id: string}).id;
  const originSession = {harness: 'codex', sessionId: 'actual-empty-plan-agent'};
  await expect(page.evaluate(async projectId => {
    const bridge = (window as unknown as {blueprint: {invoke(name: string,args: Record<string,unknown>):Promise<unknown>}}).blueprint;
    await bridge.invoke('createEmptyPlan', {projectId, operationId: crypto.randomUUID()});
  }, projectId)).rejects.toThrow('Unsupported operator command');
  await expect(page.getByRole('button', { name: 'New plan in project', exact: true })).toHaveCount(0);
  const plan = await mcp.tool('create_artifact', {projectId, title: 'Untitled plan', kind: 'blueprint', originSession, operationId: randomUUID()});
  const artifactId = String(plan.artifactId);
  await page.getByRole('button', { name: 'Project overview', exact: true }).click();
  await page.getByRole('button', { name: 'Untitled plan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for your agent' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Copy message for agent', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Project overview', exact: true }).click();
  await menuAction('Rename plan');
  await page.getByRole('button', { name: 'Untitled plan', exact: true }).click({ button: 'right' });
  const renameDialog = page.getByRole('dialog', { name: 'Rename plan' });
  await renameDialog.getByLabel('Plan name').fill('   ');
  await expect(renameDialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await renameDialog.getByLabel('Plan name').press('Enter');
  await expect(renameDialog).toBeVisible();
  await renameDialog.getByLabel('Plan name').fill('Research workspace');
  await renameDialog.getByLabel('Plan name').press('Enter');
  await expect(renameDialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Research workspace', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Research workspace', exact: true }).click();
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><title>Before document</title><style>body{background:#e6efff;min-height:1500px}h1{padding:30px}</style><h1>Private research viewport</h1>',
    );
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const url = `http://127.0.0.1:${address.port}/`;
  await page.getByRole('button', { name: 'New tab', exact: true }).first().click();
  await page.getByRole('textbox', { name: 'New tab address' }).fill(url);
  await page.getByRole('textbox', { name: 'New tab address' }).press('Enter');
  await expect(page.getByRole('tab', { name: 'Before document', exact: true })).toBeVisible();
  const manifest = await mcp.tool('read_artifact', { artifactId });
  expect(manifest).toMatchObject({
    revisionId: null,
    originSession,
    privateStateIncluded: false,
  });
  await page.getByRole('button', { name: 'Annotate browser', exact: true }).click();
  await expect
    .poll(
      () =>
        app
          .context()
          .pages()
          .filter((candidate) => candidate.url().startsWith('data:text/html;base64,')).length,
    )
    .toBe(1);
  const overlay = app
    .context()
    .pages()
    .find((candidate) => candidate.url().startsWith('data:text/html;base64,'))!;
  await overlay.mouse.move(45, 40);
  await overlay.mouse.down();
  await overlay.mouse.move(190, 105);
  await overlay.mouse.up();
  await overlay.getByLabel('Area annotation comment').fill('Research before first publication');
  await overlay.getByLabel('Area annotation comment').press('Enter');
  await expect(page.getByText('Research before first publication', { exact: true })).toBeVisible();
  expect(await mcp.tool('read_artifact', { artifactId, part: 'state' })).toMatchObject({
    savedState: null,
  });
  await page.getByRole('button', { name: 'Edit annotation 1', exact: true }).click();
  await page
    .getByLabel('Edit annotation', { exact: true })
    .fill('Unfinished edit before publication');
  await expect
    .poll(
      async () =>
        JSON.parse(await readFile(join(data, 'editors', artifactId, 'null.json'), 'utf8'))?.comment,
    )
    .toBe('Unfinished edit before publication');
  mcp.close();
  mcp = undefined;
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  // The selected workspace now restores immediately. Cancel the recovered edit
  // before navigating: navigation correctly finalizes a nonempty comment.
  await expect(page.getByLabel('Edit annotation', { exact: true })).toHaveValue(
    'Unfinished edit before publication',
  );
  await page.getByLabel('Edit annotation', { exact: true }).press('Escape');
  await expect(page.getByLabel('Edit annotation', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Project overview', exact: true }).click();
  await page.getByRole('button', { name: 'Research workspace', exact: true }).click();
  await expect(page.getByText('Research before first publication', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Before document', exact: true })).toBeVisible();
  mcp = new Mcp(socket);
  await mcp.initialize();
  expect(await mcp.tool('read_artifact', { artifactId, part: 'state' })).toMatchObject({
    savedState: null,
  });
  await mcp.tool('attach_artifact_session', {
    artifactId,
    originSession: { harness: 'codex', sessionId: 'actual-empty-plan-agent' },
    operationId: randomUUID(),
  });
  await writeFile(
    join(String(manifest.sourcePath), String(manifest.sourceFile)),
    '# First publication\n\n<TextAnswer id="decision" meaning="Decision" semanticsVersion="1" defaultValue="" />',
  );
  const revision = await mcp.tool('publish_artifact', {
    artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  });
  await mcp.tool('show_artifact', { artifactId, revisionId: revision.revisionId });
  await expect(
    page.frameLocator('iframe').getByRole('heading', { name: 'First publication' }),
  ).toBeVisible();
  await page.frameLocator('iframe').getByLabel('Decision', { exact: true }).fill('Operator answer');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Copy update message', exact: true }),
  ).toBeVisible();
  const stateResponse = await mcp.tool('read_artifact', { artifactId, part: 'state' });
  const state = JSON.parse(String(stateResponse.content)) as {
    id: string;
    formatVersion: number;
    annotations: {
      source: { revisionId: string | null; attachmentId: string };
      number: number;
      annotation: string;
    }[];
  };
  expect(state).toMatchObject({
    formatVersion: 2,
    annotations: [
      { number: 1, annotation: 'Research before first publication', source: { revisionId: null } },
    ],
  });
  const attachmentArgs = {
    artifactId,
    savedStateId: state.id,
    attachmentId: state.annotations[0].source.attachmentId,
  };
  let attachment = await mcp.tool('read_attachment', attachmentArgs),
    encoded = String(attachment.content);
  while (!attachment.complete) {
    attachment = await mcp.tool('read_attachment', {
      ...attachmentArgs,
      cursor: attachment.cursor,
    });
    encoded += String(attachment.content);
  }
  expect(attachment.mimeType).toBe('image/svg+xml');
  expect(Buffer.from(encoded, 'base64').toString()).toContain('>1</text>');
  // Unavailable projects expose Locate folder in the same menu and cannot start a session.
  await rename(project, join(root, 'moved-project'));
  const other = join(root, 'other');
  await mkdir(other);
  await choose(page, other);
  await interceptMenus();
  await page.getByRole('button', { name: 'Project actions for project', exact: true }).click();
  expect(await menuItems()).toMatchObject([
    { label: 'New session', enabled: false },
    { label: 'Locate folder' },
    { type: 'separator' },
    { label: 'Remove from list' },
  ]);
  await expect(
    page.getByRole('button', { name: 'New Codex session in project', exact: true }),
  ).toBeDisabled();
  // A missing folder must also be safe when it is the selected restored workspace.
  await page.evaluate(async () => {
    const bridge = (
      window as unknown as {
        blueprint: { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> };
      }
    ).blueprint;
    const snapshot = (await bridge.invoke('snapshot')) as {
      projects: { id: string; available?: boolean }[];
    };
    const missing = snapshot.projects.find((project) => project.available === false);
    if (!missing) throw Error('The disposable missing project was not reported.');
    await bridge.invoke('applicationCommand', {
      action: 'select',
      projectId: missing.id,
      sessionId: null,
    });
  });
  mcp.close();
  mcp = undefined;
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await expect(
    page.getByRole('button', { name: 'Project actions for project', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'New Codex session in project', exact: true }),
  ).toBeDisabled();
});
