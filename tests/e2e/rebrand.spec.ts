import { test, expect, electron, type ElectronApplication } from './test';
import { mkdtemp, mkdir, writeFile, rename, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Mcp } from './mcp';

test('Projector reopens legacy project work and browser storage without rewriting published data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'projector-rebrand-'));
  const data = join(root, 'data'),
    project = join(root, 'project'),
    descriptor = join(root, 'endpoint.json');
  await mkdir(data);
  await mkdir(project);
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Legacy profile</title><h1>Legacy browser data</h1>');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');
  const url = `http://127.0.0.1:${address.port}/`;
  let app: ElectronApplication | undefined, mcp: Mcp | undefined;
  const launch = async (legacy: boolean) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined) env[key] = value;
    delete env.PROJECTOR_DATA;
    delete env.PROJECTOR_RUNTIME_DESCRIPTOR;
    delete env.BLUEPRINT_DATA;
    delete env.BLUEPRINT_RUNTIME_DESCRIPTOR;
    if (legacy) {
      env.BLUEPRINT_DATA = data;
      env.BLUEPRINT_RUNTIME_DESCRIPTOR = descriptor;
    } else {
      env.PROJECTOR_DATA = data;
      env.PROJECTOR_RUNTIME_DESCRIPTOR = descriptor;
    }
    app = await electron.launch({ args: [resolve('.')], env });
    const page = await app.firstWindow();
    await expect(page.locator('.titlebar-brand-name')).toHaveText('Projector');
    await expect(page.locator('.titlebar-brand-mark')).toHaveText('P');
    expect(await app.evaluate(({ app }) => app.getName())).toBe('Projector');
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(data);
    return page;
  };
  try {
    let page = await launch(true);
    await app!.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, project);
    await page.getByRole('button', { name: '+ Open project folder', exact: true }).first().click();
    mcp = new Mcp(descriptor);
    await mcp.initialize();
    const context = await mcp.tool('get_blueprint_context', {});
    const projectId = (context.project as { id: string }).id;
    const guide = await mcp.tool('get_blueprint_guide', {});
    expect(guide.content).toContain('Projector');
    const artifact = await mcp.tool('create_artifact', {
      projectId,
      kind: 'blueprint',
      title: 'Preserved legacy plan',
      originSession: { harness: 'codex', sessionId: 'legacy-author' },
      operationId: randomUUID(),
    });
    await writeFile(
      join(String(artifact.sourcePath), 'plan.mdx'),
      '# Legacy plan\n\n<Choice id="q" meaning="Question" semanticsVersion="1" options={["A","B"]} defaultValue="A" />',
    );
    const revision = await mcp.tool('publish_artifact', {
      artifactId: artifact.artifactId,
      expectedLatestRevision: null,
      operationId: randomUUID(),
    });
    await mcp.tool('show_artifact', {
      artifactId: artifact.artifactId,
      revisionId: revision.revisionId,
    });
    await page.frameLocator('iframe').getByLabel('B', { exact: true }).check();
    const legacyPartition =
      'persist:blueprint-browser-' + createHash('sha256').update(projectId).digest('hex');
    await app!.evaluate(
      async ({ BrowserWindow }, { partition, url }) => {
        const old = new BrowserWindow({
          show: false,
          webPreferences: { partition, sandbox: true, contextIsolation: true },
        });
        try {
          await old.loadURL(url);
          await old.webContents.executeJavaScript('localStorage.setItem("legacy", "preserved")');
          await old.webContents.session.cookies.set({
            url,
            name: 'legacy',
            value: 'preserved',
            expirationDate: Date.now() / 1000 + 3600,
          });
          await old.webContents.session.cookies.flushStore();
          old.webContents.session.flushStorageData();
        } finally {
          old.destroy();
        }
      },
      { partition: legacyPartition, url },
    );
    const revisionPath = join(
      project,
      '.projector',
      'artifacts',
      String(artifact.artifactId),
      'revisions',
      String(revision.revisionId),
      'manifest.json',
    );
    const immutable = await readFile(revisionPath);
    mcp.close();
    mcp = undefined;
    await app!.close();
    app = undefined;
    await rename(join(project, '.projector'), join(project, '.blueprint'));
    page = await launch(false);
    mcp = new Mcp(descriptor);
    await mcp.initialize();
    expect((await mcp.tool('get_projector_context', {})).project).toMatchObject({ id: projectId });
    await mcp.tool('show_artifact', {
      artifactId: artifact.artifactId,
      revisionId: revision.revisionId,
    });
    await expect(page.frameLocator('iframe').getByLabel('B', { exact: true })).toBeChecked();
    const savedSource = await mcp.tool('read_artifact', {
      artifactId: artifact.artifactId,
      revisionId: revision.revisionId,
      part: 'source',
    });
    expect(JSON.stringify(savedSource)).toContain('# Legacy plan');
    expect(await readFile(revisionPath.replace('/.projector/', '/.blueprint/'))).toEqual(immutable);
    await mcp.tool('show_content', { artifactId: artifact.artifactId, url });
    await expect
      .poll(() =>
        app!.evaluate(async ({ webContents }, url) => {
          const page = webContents.getAllWebContents().find((item) => item.getURL() === url);
          return page ? page.executeJavaScript('localStorage.getItem("legacy")') : null;
        }, url),
      )
      .toBe('preserved');
    const cookies = await app!.evaluate(
      async ({ session }, { partition, url }) =>
        session.fromPartition(partition).cookies.get({ url }),
      { partition: legacyPartition, url },
    );
    expect(cookies).toContainEqual(expect.objectContaining({ name: 'legacy', value: 'preserved' }));
  } finally {
    mcp?.close();
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
