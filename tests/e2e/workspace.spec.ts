import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
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
test('plan-owned tabs, local comments, browser close and restart preserve independent work', async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-workspace-'));
  const data = join(root, 'data'),
    project = join(root, 'project'),
    otherProject = join(root, 'other');
  await Promise.all([data, project, otherProject].map((path) => mkdir(path)));
  const launch = () =>
    electron.launch({
      args: [resolve('.')],
      env: { ...process.env, BLUEPRINT_DATA: data, BLUEPRINT_SOCKET: join(root, 's.sock') },
    });
  app = await launch();
  let page = await app.firstWindow();
  await choose(page, project);
  mcp = new Mcp(join(root, 's.sock'));
  await mcp.initialize();
  async function create(title: string, session: string) {
    const context = await mcp!.tool('get_blueprint_context', {});
    const artifact = await mcp!.tool('create_artifact', {
      projectId: (context.project as { id: string }).id,
      kind: 'blueprint',
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
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      Object.assign(globalThis, { workspaceOpenedSession: url });
    };
  });
  await page.getByRole('button', { name: 'Open Codex session for Third plan' }).click();
  await expect
    .poll(() =>
      app.evaluate(
        () => (globalThis as unknown as { workspaceOpenedSession: string }).workspaceOpenedSession,
      ),
    )
    .toBe('codex://threads/session-three');
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
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
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
  await page.getByRole('button', { name: 'Second plan', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.getByRole('textbox', { name: 'New tab address' }).fill('https://example.test/second');
  await page.getByRole('button', { name: 'Third plan', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: 'First plan', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'First plan', exact: true })).toBeVisible();
  await expect(frame.getByLabel('Decision', { exact: true })).toHaveValue('Private answer');
  await page.getByRole('tab', { name: 'New tab', exact: true }).click();
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
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: 'New tab', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveValue(url + '/');
  await expect(page.getByRole('tab', { name: 'Local browser page', exact: true })).toBeVisible();
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
    page.getByRole('button', { name: 'Close Local browser page tab', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('tab', { name: 'Local browser page', exact: true })).toBeVisible();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 0;
  });
  await page.getByRole('button', { name: 'Close Local browser page tab', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Local browser page', exact: true })).toHaveCount(0);
  // The document can close too. Answers and comments are retained, without Save.
  await page.getByRole('tab', { name: 'Plan', exact: true }).click({ button: 'middle' });
  await expect(page.getByRole('heading', { name: 'No open tabs' })).toBeVisible();
  await page.getByRole('button', { name: 'Open plan', exact: true }).click();
  await expect(frame.getByLabel('Decision', { exact: true })).toHaveValue('Private answer');
  await expect(page.locator('.annotation p')).toContainText('Private annotation');
  await page.getByRole('button', { name: 'Close plan tab', exact: true }).click();
  await page.getByRole('button', { name: 'Second plan', exact: true }).click();
  await page.getByRole('button', { name: 'First plan', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Document version' })).toHaveValue(
    String(a.revision.revisionId),
  );
  // Leave a browser URL persisted but no live browser will load on restart.
  await mcp.tool('show_content', { artifactId: b.artifact.artifactId, url });
  await page.getByRole('button', { name: 'Second plan', exact: true }).click();
  await page.getByRole('tab', { name: 'Local browser page', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveValue(url + '/');
  await page.screenshot({ path: resolve('.tmp/tasks/compact-tabs-20261009/browser.png') });
  mcp.close();
  mcp = undefined;
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  frame = page.frameLocator('iframe');
  await page.getByRole('button', { name: 'Second plan', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect
    .poll(() =>
      app.evaluate(
        ({ webContents }) =>
          webContents.getAllWebContents().filter((c) => c.getURL().startsWith('http://127.0.0.1'))
            .length,
      ),
    )
    .toBe(0);
  await page.getByRole('tab', { name: 'New tab', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'New tab address' })).toHaveValue(
    'https://example.test/second',
  );
  await page.getByRole('tab', { name: 'Local browser page', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveValue(url + '/');
  await page.getByRole('button', { name: 'First plan', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'First plan', exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(frame.getByLabel('Decision', { exact: true })).toHaveValue('Private answer');
  await expect(page.locator('.annotation p')).toContainText('Private annotation');
  await expect(page.getByText('VISUAL PLANNING')).toHaveCount(0);
  await page.screenshot({ path: resolve('.tmp/tasks/compact-tabs-20261009/document.png') });
  await page.getByRole('button', { name: 'Edit annotation 1', exact: true }).click();
  await page.getByLabel('Edit annotation', { exact: true }).fill('Edited private annotation');
  await page.getByRole('button', { name: 'Second plan', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Second plan', exact: true })).toBeVisible();
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
  await app.evaluate(() => {
    const { Socket } = process.getBuiltinModule('net');
    const original = Socket.prototype.write;
    Socket.prototype.write = function (
      value: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) {
      if (typeof value === 'string') {
        let request: { id?: string; method?: string; params?: { name?: string } } = {};
        try {
          request = JSON.parse(value);
        } catch {
          /* other streams */
        }
        if (request.method === 'operator' && request.params?.name === 'addAnnotation') {
          Socket.prototype.write = original;
          queueMicrotask(() =>
            this.emit(
              'data',
              Buffer.from(
                JSON.stringify({
                  id: request.id,
                  error: { code: 'DISK_WRITE_FAILED', message: 'Injected isolated write failure' },
                }) + '\n',
              ),
            ),
          );
          return true;
        }
      }
      return original.call(
        this,
        value,
        typeof encodingOrCallback === 'function' ? undefined : encodingOrCallback,
        typeof encodingOrCallback === 'function' ? encodingOrCallback : callback,
      );
    };
  });
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(frame.getByLabel('Annotation comment', { exact: true })).toHaveValue(
    'Retry this comment',
  );
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'New tab address' })).toBeVisible();
  await expect(page.locator('.annotation p').filter({ hasText: 'Retry this comment' })).toHaveCount(
    1,
  );
  // A failed workspace write must be detected before a live site's view closes.
  await page.getByRole('button', { name: 'Second plan', exact: true }).click();
  await page.getByRole('tab', { name: 'Local browser page', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Close Local browser page tab', exact: true }),
  ).toBeEnabled();
  const metadata = join(data, 'workspace.json'),
    backup = join(root, 'workspace.backup.json');
  await rename(metadata, backup);
  await mkdir(metadata);
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
  await rm(metadata, { recursive: true });
  await rename(backup, metadata);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Local browser page', exact: true })).toHaveCount(0);
  expect(c.artifact.artifactId).not.toBe(a.artifact.artifactId);
});
