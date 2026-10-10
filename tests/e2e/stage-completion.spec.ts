import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, rm, rename, cp, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Mcp } from './mcp';
let app: ElectronApplication, root: string, mcp: Mcp | undefined;
test.afterEach(async () => {
  mcp?.close();
  mcp = undefined;
  await app?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
test('offline guide, folder relocation and copy conflict preserve the original plan and private answers', async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-completion-'));
  const data = join(root, 'data'),
    project = join(root, 'project');
  await mkdir(data);
  await mkdir(project);
  const launch = () =>
    electron.launch({
      args: [resolve('.')],
      env: { ...process.env, BLUEPRINT_DATA: data, BLUEPRINT_SOCKET: join(root, 's.sock') },
    });
  app = await launch();
  await app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );
  });
  let page = await app.firstWindow();
  await page.getByRole('button', { name: 'Blueprint guide', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Blueprint guide' })).toContainText(
    'Available offline',
  );
  await page
    .getByRole('combobox', { name: 'Guide topic or reference' })
    .selectOption('topic:annotations');
  await expect(page.locator('.guide-content')).toContainText('stateHash');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25),
  );
  await expect(page.getByRole('combobox', { name: 'Guide topic or reference' })).toBeVisible();
  await expect(
    page
      .getByRole('dialog', { name: 'Blueprint guide' })
      .getByRole('button', { name: 'Close', exact: true }),
  ).toBeVisible();
  await mkdir(resolve('.tmp/tasks/stage-completion-20261011'), { recursive: true });
  const guideBounds = await page.getByRole('dialog', { name: 'Blueprint guide' }).boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(guideBounds!.x).toBeGreaterThanOrEqual(0);
  expect(guideBounds!.x + guideBounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  await expect(page.getByRole('dialog', { name: 'Blueprint guide' })).toHaveCSS('opacity', '1');
  const guideImage = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'),
  );
  await writeFile(
    resolve('.tmp/tasks/stage-completion-20261011/guide-enlarged.png'),
    Buffer.from(guideImage, 'base64'),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Blueprint guide' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Blueprint guide', exact: true })).toBeFocused();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, project);
  await page.getByRole('button', { name: '+ Open project folder' }).click();
  mcp = new Mcp(join(root, 's.sock'));
  await mcp.initialize();
  const context = await mcp.tool('get_blueprint_context', {});
  expect(context.capabilities).toMatchObject({
    limits: { version: '1', compileTimeoutMs: 30000, captureTimeoutMs: 10000 },
  });
  const a = await mcp.tool('create_artifact', {
    projectId: (context.project as { id: string }).id,
    kind: 'blueprint',
    title: 'Original plan',
    originSession: { harness: 'codex', sessionId: 'original' },
    operationId: randomUUID(),
  });
  await writeFile(
    join(String(a.sourcePath), 'plan.mdx'),
    '# Original plan\n\n<TextAnswer id="answer" meaning="Decision" semanticsVersion="1" defaultValue="" />',
  );
  const r = await mcp.tool('publish_artifact', {
    artifactId: a.artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  });
  await mcp.tool('show_artifact', { artifactId: a.artifactId, revisionId: r.revisionId });
  const frame = page.frameLocator('iframe');
  await frame.getByRole('textbox').fill('PRIVATE retained');
  await expect(page.getByText('Unsaved working changes', { exact: false })).toBeVisible();
  mcp.close();
  mcp = undefined;
  await app.close();
  await rename(project, join(root, 'moved'));
  app = await launch();
  page = await app.firstWindow();
  await expect(page.getByText('Folder unavailable')).toBeVisible();
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    },
    join(root, 'moved'),
  );
  await page.getByRole('button', { name: 'Locate folder' }).click();
  await page.getByRole('button', { name: 'Original plan', exact: true }).click();
  await expect(page.frameLocator('iframe').getByRole('textbox')).toHaveValue('PRIVATE retained');
  await cp(join(root, 'moved'), join(root, 'copy'), { recursive: true });
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
    },
    join(root, 'copy'),
  );
  await page.getByRole('button', { name: '+ Open project folder' }).click();
  await expect(page.locator('.project-row')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Original plan', exact: true })).toHaveCount(1);
  await expect(page.frameLocator('iframe').getByRole('textbox')).toHaveValue('PRIVATE retained');
});
test('version summary and approval revocation are visible and separate from Save', async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-revoke-'));
  await mkdir(join(root, 'project'));
  await mkdir(join(root, 'data'));
  app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...process.env,
      BLUEPRINT_DATA: join(root, 'data'),
      BLUEPRINT_SOCKET: join(root, 's.sock'),
    },
  });
  const page = await app.firstWindow();
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    },
    join(root, 'project'),
  );
  await page.getByRole('button', { name: '+ Open project folder' }).click();
  mcp = new Mcp(join(root, 's.sock'));
  await mcp.initialize();
  const context = await mcp.tool('get_blueprint_context', {});
  const a = await mcp.tool('create_artifact', {
    projectId: (context.project as { id: string }).id,
    kind: 'blueprint',
    title: 'Agreement',
    originSession: { harness: 'codex', sessionId: 'agreement' },
    operationId: randomUUID(),
  });
  const source =
    '# Agreement\n\n<Choice id="role" meaning="Role" semanticsVersion="1" options={["Owner","Member"]} defaultValue="Owner" />';
  await writeFile(join(String(a.sourcePath), 'plan.mdx'), source);
  const first = await mcp.tool('publish_artifact', {
    artifactId: a.artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  });
  await writeFile(
    join(String(a.sourcePath), 'plan.mdx'),
    source + '\n\n<TextAnswer id="reason" meaning="Reason" semanticsVersion="1" defaultValue="" />',
  );
  const r = await mcp.tool('publish_artifact', {
    artifactId: a.artifactId,
    expectedLatestRevision: first.revisionId,
    operationId: randomUUID(),
  });
  await mcp.tool('show_artifact', { artifactId: a.artifactId, revisionId: r.revisionId });
  await page.getByText('Answers in this version').click();
  await expect(page.locator('.migration-summary')).toContainText('Retained: role');
  await expect(page.locator('.migration-summary')).toContainText('New: reason');
  await page.getByRole('button', { name: 'Annotate document', exact: true }).click();
  const frame = page.frameLocator('iframe');
  const area = frame.getByRole('application', { name: 'Select annotation area' });
  await area.press('ArrowDown');
  await expect(frame.locator('.element-hover-outline')).toBeVisible();
  await area.press('Enter');
  const comment = frame.getByLabel('Annotation comment');
  await comment.fill('Keyboard annotation');
  await comment.press('Shift+Enter');
  await comment.press('K');
  await expect(comment).toHaveValue('Keyboard annotation\nK');
  await comment.press('Enter');
  await expect(comment).toHaveCount(0);
  await expect(page.locator('.annotations .annotation')).toContainText('Keyboard annotation');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Approve this version' }).click();
  await page.getByRole('button', { name: 'Revoke approval' }).click();
  await expect(page.getByRole('button', { name: 'Approve this version' })).toBeEnabled();
  const metadata = await mcp.tool('read_artifact', { artifactId: a.artifactId });
  expect((metadata.approvalHistory as { type: string }[]).map((x) => x.type)).toEqual([
    'approved',
    'revoked',
  ]);
  if (process.env.BLUEPRINT_E2E_VISIBLE === '1') {
    await frame.getByRole('textbox', { name: 'Reason' }).fill('Private renderer recovery');
    await expect(page.getByText('Unsaved working changes', { exact: false })).toBeVisible();
    await app.evaluate(
      ({ dialog, BrowserWindow }) =>
        new Promise<void>((resolve) => {
          dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
          const target = BrowserWindow.getAllWindows()[0];
          target.webContents.once('did-finish-load', () => resolve());
          target.webContents.forcefullyCrashRenderer();
        }),
    );
    // Playwright marks a crashed Page terminally. Read the recovered real renderer
    // through Electron, rather than replacing the crash with a synthetic reload.
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
            "document.querySelector('.annotations')?.textContent ?? ''",
          ),
        ),
      )
      .toContain('Keyboard annotation');
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const shell = BrowserWindow.getAllWindows()[0].webContents;
          const document = shell.mainFrame.frames.find((frame) =>
            frame.url.startsWith('blueprint://document'),
          );
          return (
            document?.executeJavaScript("document.querySelector('textarea')?.value ?? ''") ?? ''
          );
        }),
      )
      .toBe('Private renderer recovery');
    const saved = await mcp.tool('read_artifact', { artifactId: a.artifactId, part: 'state' });
    expect(String(saved.content)).not.toContain('Private renderer recovery');
  }
});

test('a failed Save retry remains bound to its own artifact when another plan is selected', async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-save-target-'));
  await mkdir(join(root, 'project'));
  await mkdir(join(root, 'data'));
  app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...process.env,
      BLUEPRINT_DATA: join(root, 'data'),
      BLUEPRINT_SOCKET: join(root, 's.sock'),
    },
  });
  const page = await app.firstWindow();
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    },
    join(root, 'project'),
  );
  await page.getByRole('button', { name: '+ Open project folder' }).click();
  mcp = new Mcp(join(root, 's.sock'));
  await mcp.initialize();
  const context = await mcp.tool('get_blueprint_context', {});
  const plans = [];
  for (const title of ['Plan A', 'Plan B']) {
    const a = await mcp.tool('create_artifact', {
      projectId: (context.project as { id: string }).id,
      kind: 'blueprint',
      title,
      originSession: { harness: 'codex', sessionId: title.replaceAll(' ', '-') },
      operationId: randomUUID(),
    });
    await writeFile(join(String(a.sourcePath), 'plan.mdx'), '# ' + title);
    const revision = await mcp.tool('publish_artifact', {
      artifactId: a.artifactId,
      expectedLatestRevision: null,
      operationId: randomUUID(),
    });
    plans.push({
      artifactId: a.artifactId,
      revisionId: revision.revisionId,
      path: resolve(String(a.sourcePath), '..'),
    });
  }
  await mcp.tool('show_artifact', {
    artifactId: plans[0].artifactId,
    revisionId: plans[0].revisionId,
  });
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Plan A' })).toBeVisible();
  await chmod(plans[0].path, 0o555);
  try {
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry Save', exact: true })).toBeVisible();
  } finally {
    await chmod(plans[0].path, 0o755);
  }
  await page.getByRole('button', { name: 'Plan B', exact: true }).click();
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Plan B' })).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Copy update message', exact: true }),
  ).toBeVisible();
  expect(
    await mcp.tool('read_artifact', { artifactId: plans[0].artifactId, part: 'state' }),
  ).toMatchObject({ savedState: null });
  expect(
    (await mcp.tool('read_artifact', { artifactId: plans[1].artifactId, part: 'state' })).content,
  ).toContain(String(plans[1].artifactId));
  await page.getByRole('button', { name: 'Plan A', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry Save', exact: true })).toBeVisible();
});
