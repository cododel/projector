import { openProjectOverview } from './workspace-ui';
import { test, expect, electron, type ElectronApplication } from './test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from '../support/process';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer, type Server } from 'node:http';
import { paneLeaves, type ApplicationWorkspaceSnapshot } from '../../src/shared/application-workspace';

class BrowserMcp {
  private child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  constructor(socket: string) {
    this.child = spawn(process.execPath, [resolve('out/bridge.cjs')], {
      env: { ...process.env, PROJECTOR_RUNTIME_DESCRIPTOR: socket },
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.id === 'number') {
        this.pending.get(value.id)?.resolve(value);
        this.pending.delete(value.id);
      }
    });
    this.child.once('exit', () => {
      for (const request of this.pending.values()) request.reject(new Error('Bridge disconnected'));
      this.pending.clear();
      lines.close();
    });
  }
  private request(method: string, params: unknown) {
    const id = ++this.next;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async initialize() {
    const response = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'browser-state-e2e', version: '1' },
    });
    expect(response.result).toBeTruthy();
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
  }
  async tool(name: string, args: unknown) {
    const response = await this.request('tools/call', { name, arguments: args });
    const result = response.result as { content: { text: string }[]; isError?: boolean };
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text) as Record<string, unknown>;
  }
  close() {
    this.child.stdin.end();
  }
}

let app: ElectronApplication;
let mcp: BrowserMcp;
let root: string;
let server: Server;
test.afterEach(async () => {
  mcp?.close();
  await app?.close();
  if (server)
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  if (root) await rm(root, { recursive: true, force: true });
});

test('application browser composer survives restart, remains private, and Save exposes a numbered attachment through MCP', async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-browser-state-'));
  const data = join(root, 'data');
  const project = join(root, 'project');
  const socket = join(root, 's.sock');
  await mkdir(data);
  await mkdir(project);
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><title>Scenario browser</title><h1>Snapshot scenario</h1><p>Review this result</p><style>body{min-height:1800px;background:#f2f6ff}h1{padding:30px;background:#fff6d0}</style>',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture server address');
  const url = `http://127.0.0.1:${address.port}/`;
  const launch = () =>
    electron.launch({
      args: [resolve('.')],
      env: { ...process.env, PROJECTOR_DATA: data, PROJECTOR_RUNTIME_DESCRIPTOR: socket },
    });
  app = await launch();
  let page = await app.firstWindow();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, project);
  await page.getByRole('button', { name: '+ Open project folder' }).click();
  mcp = new BrowserMcp(socket);
  await mcp.initialize();
  const context = await mcp.tool('get_projector_context', {});
  const artifact = await mcp.tool('create_artifact', {
    projectId: (context.project as { id: string }).id,
    kind: 'projector',
    title: 'Browser planning scenario',
    originSession: { harness: 'codex', sessionId: 'browser-scenario-session' },
    operationId: randomUUID(),
  });
  const source =
    '# Browser planning scenario\n\nInspect external behavior before agreeing on requirements.';
  await writeFile(join(String(artifact.sourcePath), 'plan.mdx'), source);
  const first = await mcp.tool('publish_artifact', {
    artifactId: artifact.artifactId,
    expectedLatestRevision: null,
    operationId: randomUUID(),
  });
  await mcp.tool('show_artifact', {
    artifactId: artifact.artifactId,
    revisionId: first.revisionId,
  });
  await mcp.tool('show_content', { artifactId: artifact.artifactId, url });
  await expect(page.getByRole('tab', { name: 'Scenario browser', exact: true })).toBeVisible();
  const originalBounds = await page.locator('.browser-area').boundingBox();
  if (!originalBounds) throw new Error('Missing browser pane bounds');
  const rounded = ({ x, y, width, height }: typeof originalBounds) => ({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
  const host = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentSize(),
  );
  const geometry = async () => {
    // Read both current surfaces on every attempt. A DOM snapshot captured halfway
    // through the sidebar transition is not the intended final native bounds.
    const shell = await page.locator('.browser-area').boundingBox();
    if (!shell) throw new Error('Missing browser pane bounds');
    const native = await app.evaluate(({ BrowserWindow, WebContentsView }, url) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
        (view) => view instanceof WebContentsView && view.webContents.getURL() === url,
      );
      return view?.getBounds();
    }, url);
    return { shell: rounded(shell), native };
  };
  await page.getByRole('button', { name: 'Hide projects sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Hide feedback sidebar', exact: true }).click();
  const expandedBounds = {
    x: 0,
    y: Math.round(originalBounds.y),
    width: host[0],
    height: host[1] - Math.round(originalBounds.y),
  };
  expect(expandedBounds.width).toBeGreaterThan(originalBounds.width + 400);
  await expect.poll(geometry).toEqual({ shell: expandedBounds, native: expandedBounds });
  await page.getByRole('button', { name: 'Show projects sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Show feedback sidebar', exact: true }).click();
  await expect
    .poll(geometry)
    .toEqual({ shell: rounded(originalBounds), native: rounded(originalBounds) });
  await page.getByRole('button', { name: 'Annotate browser', exact: true }).click();
  await expect
    .poll(
      () =>
        app
          .context()
          .pages()
          .filter((p) => p.url().startsWith('data:text/html;base64,')).length,
    )
    .toBe(1);
  let overlay = app
    .context()
    .pages()
    .find((p) => p.url().startsWith('data:text/html;base64,'))!;
  await overlay.mouse.move(45, 40);
  await overlay.mouse.down();
  await overlay.mouse.move(190, 105);
  await overlay.mouse.up();
  await overlay
    .getByLabel('Area annotation comment')
    .fill('This captured case needs clarification');
  await expect
    .poll(async () => {
      const editor = JSON.parse(
        await readFile(
          join(data, 'browser-editors', String(artifact.artifactId) + '.json'),
          'utf8',
        ),
      ) as { comment?: string } | null;
      return editor?.comment;
    })
    .toBe('This captured case needs clarification');
  expect(
    await mcp.tool('read_artifact', { artifactId: artifact.artifactId, part: 'state' }),
  ).toMatchObject({ savedState: null, privateStateIncluded: false });
  // Agent publication must not move a pending annotation to the new document revision.
  await writeFile(
    join(String(artifact.sourcePath), 'plan.mdx'),
    source + '\n\nA new version is ready.',
  );
  const next = await mcp.tool('publish_artifact', {
    artifactId: artifact.artifactId,
    expectedLatestRevision: first.revisionId,
    operationId: randomUUID(),
  });
  await mcp.tool('show_artifact', { artifactId: artifact.artifactId, revisionId: next.revisionId });
  mcp.close();
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  // The restored browser pane already owns the unfinished composer. Opening the
  // document is a real pane transition and correctly finishes that comment.
  await expect(page.getByRole('tab', { name: 'Scenario browser', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect
    .poll(
      () =>
        app
          .context()
          .pages()
          .filter((p) => p.url().startsWith('data:text/html;base64,')).length,
    )
    .toBe(1);
  overlay = app
    .context()
    .pages()
    .find((p) => p.url().startsWith('data:text/html;base64,'))!;
  await expect(overlay.getByLabel('Area annotation comment')).toHaveValue(
    'This captured case needs clarification',
  );
  // Restoring the private editor and the browser pane must share one native page.
  await expect.poll(() => app.context().pages().filter((p) => p.url() === url).length).toBe(1);
  const restoredOwnership = await page.evaluate(async () => {
    const bridge = (window as unknown as {
      projector: { invoke(name: string): Promise<unknown> };
    }).projector;
    return {
      application: await bridge.invoke('applicationSnapshot'),
      browser: await bridge.invoke('browserSnapshot'),
    };
  }) as {
    application: ApplicationWorkspaceSnapshot;
    browser: { activeTabId: string; tabs: { id: string; url: string }[] };
  };
  const restoredWorkspace = restoredOwnership.application.workspaces[
    restoredOwnership.application.selectedWorkspace!
  ];
  const restoredBrowserPanes = restoredWorkspace.tabs.flatMap((tab) => paneLeaves(tab.root))
    .filter((pane) => pane.content.kind === 'plan' && pane.content.tab.kind === 'browser');
  expect(restoredBrowserPanes).toHaveLength(1);
  expect(restoredBrowserPanes[0].content).toMatchObject({
    kind: 'plan',
    artifactId: artifact.artifactId,
    tab: { kind: 'browser', nativeId: restoredOwnership.browser.activeTabId, url },
  });
  expect(restoredOwnership.browser.tabs).toHaveLength(1);
  await overlay.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(
    page.getByText('This captured case needs clarification', { exact: true }),
  ).toBeVisible();
  mcp = new BrowserMcp(socket);
  await mcp.initialize();
  expect(
    await mcp.tool('read_artifact', { artifactId: artifact.artifactId, part: 'state' }),
  ).toMatchObject({ savedState: null });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Copy update message', exact: true }),
  ).toBeVisible();
  const stateResult = await mcp.tool('read_artifact', {
    artifactId: artifact.artifactId,
    part: 'state',
  });
  const state = JSON.parse(String(stateResult.content)) as {
    id: string;
    annotations: {
      number: number;
      annotation: string;
      source: { revisionId: string; attachmentId: string };
    }[];
    attachments: { id: string; number: number }[];
  };
  expect(state.annotations).toHaveLength(1);
  expect(state.annotations[0]).toMatchObject({
    number: 1,
    annotation: 'This captured case needs clarification',
    source: {
      revisionId: first.revisionId,
      capture: {
        pageId: expect.any(String),
        stateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        layoutHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    },
  });
  const attachmentArgs = {
    artifactId: artifact.artifactId,
    savedStateId: state.id,
    attachmentId: state.attachments[0].id,
  };
  let attachment = await mcp.tool('read_attachment', attachmentArgs);
  let base64 = String(attachment.content);
  while (!attachment.complete) {
    attachment = await mcp.tool('read_attachment', {
      ...attachmentArgs,
      cursor: attachment.cursor,
    });
    base64 += String(attachment.content);
  }
  expect(attachment.mimeType).toBe('image/svg+xml');
  const image = Buffer.from(base64, 'base64').toString();
  expect(image).toContain('data:image/png;base64,');
  expect(image).toContain('<rect');
  expect(image).toContain('<path d=');
  expect(image).toContain('>1</text>');
  // Reopen the persisted capture from the Plan surface, without any active native browser tab.
  mcp.close();
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await openProjectOverview(page);
  await page.getByRole('button', { name: 'Browser planning scenario', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Plan', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Browser planning scenario' })).toBeVisible();
  await page
    .locator('.annotation')
    .filter({ hasText: 'This captured case needs clarification' })
    .locator('.annotation-jump')
    .click();
  await expect
    .poll(
      () =>
        app
          .context()
          .pages()
          .filter((p) => p.url().startsWith('data:text/html;base64,')).length,
    )
    .toBe(1);
  overlay = app
    .context()
    .pages()
    .find((p) => p.url().startsWith('data:text/html;base64,'))!;
  await expect(overlay.getByRole('status')).toContainText('Saved capture');
  await expect(overlay.locator('#number')).toHaveText('1');
  expect(
    await overlay.locator('#capture').evaluate((image) => image.getBoundingClientRect().width),
  ).toBeGreaterThan(200);
});
