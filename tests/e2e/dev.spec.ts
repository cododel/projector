import { newBrowserTab } from './workspace-ui';
import { randomUUID } from 'node:crypto';
import { Mcp } from './mcp';
import { test, expect, electron } from './test';
import { createServer } from 'vite';
import { createServer as createHttpServer } from 'node:http';
import react from '@vitejs/plugin-react';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
test('development renderer proxy loads the isolated document without production assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bp-dev-'));
  const data = join(root, 'data');
  const project = join(root, 'project');
  await mkdir(data);
  await mkdir(project);
  const hmrServer = createHttpServer();
  await new Promise<void>(done => hmrServer.listen(0,'127.0.0.1',done));
  const hmrAddress = hmrServer.address();
  if (!hmrAddress || typeof hmrAddress==='string') throw new Error('Missing HMR endpoint');
  const server = await createServer({
    configFile: false,
    root: resolve('src/renderer'),
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0, hmr: {server:hmrServer,host:'127.0.0.1',protocol:'ws',clientPort:hmrAddress.port,port:hmrAddress.port} },
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (typeof address !== 'object' || !address) throw new Error('No Vite address');
  const url = `http://127.0.0.1:${address.port}`;
  const app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...process.env,
      PROJECTOR_DATA: data,
      PROJECTOR_RUNTIME_DESCRIPTOR: join(root, 's.sock'),
      ELECTRON_RENDERER_URL: url,
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole('heading', { name: 'Make decisions before implementation' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'MCP connection', exact: true }).click();
    const setup = page.getByRole('dialog', { name: 'MCP connection' });
    await expect(setup).toContainText(`PROJECTOR_RUNTIME_DESCRIPTOR = ${JSON.stringify(join(root, 's.sock'))}`);
    await expect(setup).toContainText('Development');
    // Observe the IPC clipboard boundary without changing the operator's OS clipboard.
    await app.evaluate(({ clipboard }) => {
      clipboard.writeText = async (text: string) => {
        Object.assign(globalThis, { projectorCopiedText: text });
      };
    });
    await setup.getByRole('button', { name: 'Copy setup prompt', exact: true }).click();
    await expect(setup.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    const prompt = await app.evaluate(
      () => (globalThis as unknown as { projectorCopiedText: string }).projectorCopiedText,
    );
    expect(prompt).toContain('Configure the local Projector MCP server');
    expect(prompt).toContain('user-level configuration only');
    expect(prompt).toContain('Do not create or modify project .codex/config.toml');
    expect(prompt).toContain('Do not stage or commit configuration');
    expect(prompt).toContain(`PROJECTOR_RUNTIME_DESCRIPTOR = ${JSON.stringify(join(root, 's.sock'))}`);
    expect(prompt).toContain('Do not change skills, hooks, AGENTS.md');
    expect(prompt).toContain('reconnect');
    await setup.getByText('Connection details and manual configuration', { exact: true }).click();
    await setup.getByRole('button', { name: 'Copy configuration', exact: true }).click();
    await expect(setup.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    const config = await app.evaluate(
      () => (globalThis as unknown as { projectorCopiedText: string }).projectorCopiedText,
    );
    expect(config.startsWith('[mcp_servers.projector]')).toBe(true);
    expect(prompt).toContain(config.trim());
    await setup.getByRole('button', { name: 'Close', exact: true }).click();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, project);
    await page.getByRole('button', { name: '+ Open project folder' }).click();
    await expect(page.locator('.project-dashboard')).toBeVisible();
    await page.screenshot({ path: '.tmp/tasks/project-orchestrator-20261012/development-project-overview.png' });
    await expect(page.getByText('RECIPIENT SESSION')).toHaveCount(0);
    const mcp = new Mcp(join(root, 's.sock'));
    try {
      await mcp.initialize();
      const context = await mcp.tool('get_projector_context', {});
      const a = await mcp.tool('create_artifact', {
        projectId: (context.project as { id: string }).id,
        kind: 'projector',
        title: 'Development plan',
        originSession: { harness: 'codex', sessionId: 'dev-test' },
        operationId: randomUUID(),
      });
      await writeFile(
        join(String(a.sourcePath), 'plan.mdx'),
        '# Development plan\n\n```mermaid\ngraph LR; A-->B;\n```\n\n<TextAnswer id="decision" meaning="Decision" semanticsVersion="1" defaultValue="" />',
      );
      const r = await mcp.tool('publish_artifact', {
        artifactId: a.artifactId,
        expectedLatestRevision: null,
        operationId: randomUUID(),
      });
      await mcp.tool('show_artifact', { artifactId: a.artifactId, revisionId: r.revisionId });
      const frame = page.frameLocator('iframe');
      await expect(frame.getByRole('heading', { name: 'Development plan' })).toBeVisible();
      await expect(frame.locator('.diagram svg')).toBeVisible();
      await frame.getByLabel('Decision', { exact: true }).fill('Use the existing contract');
      await expect(page.getByText('Saved locally')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Annotate document', exact: true }),
      ).toBeEnabled();
      const originalWidth = (await page.locator('iframe').boundingBox())!.width;
      await page.getByRole('button', { name: 'Hide feedback sidebar' }).click();
      await expect(page.getByRole('button', { name: 'Show feedback sidebar' })).toBeVisible();
      await expect
        .poll(async () => frame.locator('body').evaluate(() => innerWidth))
        .toBeGreaterThan(1000);
      await frame
        .locator('body')
        .evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
      const sidebarImage = test.info().outputPath('development-sidebar-layout.png');
      await page.screenshot({ path: sidebarImage });
      await test.info().attach('development-sidebar-layout', {
        path: sidebarImage, contentType: 'image/png',
      });
      await page.getByRole('button', { name: 'Show feedback sidebar' }).click();
      await expect
        .poll(async () => (await page.locator('iframe').boundingBox())!.width)
        .toBe(originalWidth);
      // Wait for Chromium to paint the restored sidebar before dispatching native mouse input.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Copy update message', exact: true }),
      ).toBeVisible();
      const saved = await mcp.tool('read_artifact', { artifactId: a.artifactId, part: 'state' });
      expect(String(saved.content)).toContain('Use the existing contract');
      const documentImage = test.info().outputPath('development-document.png');
      await page.screenshot({ path: documentImage });
      await test.info().attach('development-document', {
        path: documentImage, contentType: 'image/png',
      });
      await newBrowserTab(page);
      await expect(page.getByRole('textbox', { name: 'New tab address' })).toBeFocused();
      await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveCount(0);
      const homeImage = test.info().outputPath('development-home.png');
      await page.screenshot({ path: homeImage });
      await test.info().attach('development-home', {
        path: homeImage, contentType: 'image/png',
      });
      await page.getByRole('tab', { name: 'Plan', exact: true }).click();
      await expect(frame.getByLabel('Decision', { exact: true })).toHaveValue(
        'Use the existing contract',
      );
    } finally {
      mcp.close();
    }
  } finally {
    await app.close();
    await server.close();
    if (hmrServer.listening) await new Promise<void>((done,reject)=>hmrServer.close(error=>error?reject(error):done()));
    await rm(root, { recursive: true, force: true });
  }
});
