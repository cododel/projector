import {
  test,
  expect,
  electron,
  type ElectronApplication,
  type Page,
} from './test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';

let app: ElectronApplication;
let root: string;
let server: Server;
let url: string;
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-browser-'));
  server = createServer((request, response) => {
    if (request.url?.startsWith('/interrupted-')) return;
    if (request.url === '/network-failure') {
      request.socket.destroy();
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    if (request.url?.startsWith('/pixels')) {
      const second = request.url.includes('state=2');
      response.end(`<!doctype html><title>Pixel fixture</title><style>
        html,body{margin:0;background:${second ? 'rgb(205,44,71)' : 'rgb(23,171,61)'};min-height:3000px}
        #scroll-marker{position:absolute;left:80px;top:180px;width:80px;height:80px;background:rgb(113,51,149)}
        #marker{position:fixed;left:700px;top:400px;width:40px;height:40px;background:rgb(19,67,211)}
        </style><h1>State ${second ? 2 : 1}</h1><div id="marker"></div><div id="scroll-marker"></div>`);
      return;
    }
    response.end(
      '<!doctype html><title>Browser fixture</title><style>body{min-height:2000px;background:#eef}h1{background:#ffc;padding:25px}</style><h1>External page</h1><a href="/next">Next page</a><p>' +
        request.url +
        '</p>',
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture server address');
  url = `http://127.0.0.1:${address.port}/`;
  await build({
    entryPoints: [resolve('tests/fixtures/browser-main.ts')],
    outfile: join(root, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    loader: { '.css': 'text' },
    external: ['electron'],
  });
  await build({
    entryPoints: [resolve('src/preload/browser-overlay.ts')],
    outfile: join(root, 'overlay.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
  });
  app = await electron.launch({
    args: [join(root, 'main.cjs')],
    env: { ...process.env, PROJECTOR_BROWSER_TEST_DATA: root },
  });
  await app.firstWindow();
});
test.afterEach(async () => {
  await app?.close();
  await new Promise<void>((done, reject) =>
    server?.close((error) => (error ? reject(error) : done())),
  );
  if (root) await rm(root, { recursive: true, force: true });
});

async function pageAt(predicate: (page: Page) => boolean) {
  await expect.poll(() => app.context().pages().filter(predicate).length).toBeGreaterThan(0);
  return app.context().pages().find(predicate)!;
}

test('native external views isolate project profiles and reject privileged navigation', async () => {
  const first = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
  expect(
    await external.evaluate(() => ({
      process: typeof (window as unknown as { process?: unknown }).process,
      projector: typeof (window as unknown as { projector?: unknown }).projector,
      capture: typeof (window as unknown as { projectorCapture?: unknown }).projectorCapture,
    })),
  ).toEqual({ process: 'undefined', projector: 'undefined', capture: 'undefined' });
  await external.evaluate(() => {
    document.cookie = 'privateproject=one;path=/';
  });
  await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-b',
        projectId: 'project-b',
        url: url + 'other',
      }),
    url,
  );
  const other = await pageAt((page) => page.url() === url + 'other');
  await expect(other.getByRole('heading', { name: 'External page' })).toBeVisible();
  expect(await other.evaluate(() => document.cookie)).not.toContain('privateproject=one');
  await app.evaluate((_electron, id) => globalThis.browserTest.manager.select(id), first.id);
  await external.evaluate(() => {
    location.href = 'file:///etc/passwd';
  });
  await expect.poll(() => external.url()).toBe(url);
  const denied = await app.evaluate(async (_electron, id) => {
    try {
      await globalThis.browserTest.manager.command({
        tabId: id,
        action: 'navigate',
        url: 'projector://app/index.html',
      });
      return 'allowed';
    } catch (error) {
      return (error as Error).message;
    }
  }, first.id);
  expect(denied).toContain('INVALID_URL');
  await app.evaluate(async (_electron, args) => globalThis.browserTest.manager.command(args), {
    tabId: first.id,
    action: 'navigate' as const,
    url: url + 'next',
  });
  await expect.poll(() => external.url()).toBe(url + 'next');
  await app.evaluate(
    async (_electron, id) => globalThis.browserTest.manager.command({ tabId: id, action: 'back' }),
    first.id,
  );
  await expect.poll(() => external.url()).toBe(url);
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'forward' }),
    first.id,
  );
  await expect.poll(() => external.url()).toBe(url + 'next');
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'reload' }),
    first.id,
  );
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
});

test('cancelled initial and toolbar loads do not report browser errors', async ({ diagnostics }) => {
  const requestStarted = (path: string) => new Promise<void>((resolve) => {
    const onRequest = (request: IncomingMessage) => {
      if (request.url !== path) return;
      server.off('request', onRequest);
      resolve();
    };
    server.on('request', onRequest);
  });
  const opening = requestStarted('/interrupted-open');
  const tab = await app.evaluate((_electron, url) =>
    globalThis.browserTest.manager.open({ artifactId: 'artifact-a', projectId: 'project-a', url }),
  url + 'interrupted-open');
  await opening;
  const navigate = (target: string) => app.evaluate((_electron, { tabId, url }) =>
    globalThis.browserTest.manager.command({ tabId, action: 'navigate', url }),
  { tabId: tab.id, url: target });
  await navigate(url + 'replacement-open');
  const state = () => app.evaluate((_electron, tabId) =>
    globalThis.browserTest.manager.snapshot().tabs.find((entry) => entry.id === tabId),
  tab.id);
  await expect.poll(state).toMatchObject({
    url: url + 'replacement-open',
    loading: false,
    error: null,
  });

  const navigating = requestStarted('/interrupted-navigation');
  const navigation = navigate(url + 'interrupted-navigation').then(
    () => null,
    (error: Error) => error.message,
  );
  await navigating;
  await navigate(url + 'replacement-navigation');
  expect(await navigation).toBeNull();
  await expect.poll(state).toMatchObject({
    url: url + 'replacement-navigation',
    loading: false,
    error: null,
  });
  diagnostics.expect({
    role: 'main',
    kind: 'console-error',
    phase: 'test',
    message: /^\(node:\d+\) electron: Failed to load URL: http:\/\/127\.0\.0\.1:\d+\/network-failure with error: ERR_EMPTY_RESPONSE\n\(Use `Electron --trace-warnings \.\.\.` to show where the warning was created\)$/,
    count: 1,
  });
  await expect(navigate(url + 'network-failure')).rejects.toThrow('ERR_EMPTY_RESPONSE');
  await expect.poll(state).toMatchObject({ loading: false, error: 'ERR_EMPTY_RESPONSE' });
});

test('area annotation uses frozen viewport, private composer, and numbered captured PNG', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
  await app.evaluate(({ webContents }, url) => {
    webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === url)!
      .setZoomFactor(1.25);
  }, url);
  await external.evaluate(() => window.scrollTo(0, 140));
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
    tab.id,
  );
  const overlay = await pageAt((page) => page.url().startsWith('data:text/html;base64,'));
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  await expect(overlay.locator('#capture')).toBeHidden();
  await overlay.mouse.move(70, 50);
  await overlay.mouse.down();
  await overlay.mouse.move(230, 150);
  await overlay.mouse.up();
  await overlay.emulateMedia({ colorScheme: null });
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await expect(overlay.locator('#composer')).toHaveCSS('background-color', 'rgb(23, 25, 29)');
  await expect(overlay.locator('#rectangle')).toHaveCSS('border-top-color', 'rgb(150, 178, 215)');
  await expect(external.locator('body')).toHaveCSS('background-color', 'rgb(238, 238, 255)');
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
  await expect(overlay.locator('#composer')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await overlay.getByLabel('Area annotation comment').fill('Investigate this captured result');
  await overlay.screenshot({ path: '.tmp/tasks/annotation-polish-20261010/browser-composer.png' });
  await expect
    .poll(() =>
      app.evaluate(() => {
        const drafts = globalThis.browserTest.drafts;
        return (drafts.at(-1) as { comment?: string } | null)?.comment;
      }),
    )
    .toBe('Investigate this captured result');
  const original = await overlay.locator('#capture').getAttribute('src');
  await external.evaluate(() => {
    document.body.style.background = 'red';
    document.querySelector('h1')!.textContent = 'Changed after capture';
  });
  await app.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    contents.setZoomFactor(1.5);
    await contents.loadURL(url + 'changed');
  }, url);
  expect(await overlay.locator('#capture').getAttribute('src')).toBe(original);
  await overlay.getByLabel('Area annotation comment').evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    );
  });
  expect(await app.evaluate(() => globalThis.browserTest.annotations.length)).toBe(0);
  await overlay.screenshot({ path: '.tmp/tasks/comment-composer-20261009/browser.png' });
  await overlay.getByLabel('Area annotation comment').press('Shift+Enter');
  await expect(overlay.getByLabel('Area annotation comment')).toHaveValue(
    'Investigate this captured result\n',
  );
  await overlay.getByLabel('Area annotation comment').press('Backspace');
  await overlay.getByLabel('Area annotation comment').press('Enter');
  await expect.poll(() => app.evaluate(() => globalThis.browserTest.annotations.length)).toBe(1);
  await expect(overlay.getByRole('status')).toContainText('Saved capture');
  await expect(overlay.locator('#composer')).toBeHidden();
  await expect(overlay.locator('#rectangle')).toBeVisible();
  await expect(overlay.locator('#number')).toHaveText('1');
  expect(await overlay.locator('#capture').getAttribute('src')).toBe(original);
  const saved = await app.evaluate(() => globalThis.browserTest.annotations[0]);
  expect(saved).toMatchObject({
    artifactId: 'artifact-a',
    revisionId: 'source-version-1',
    comment: 'Investigate this captured result',
    capture: {
      source: {
        kind: 'browser-area',
        url,
        zoomFactor: 1.25,
        scroll: { x: 0, y: 140 },
        viewport: { width: 840, height: 540 },
      },
    },
  });
  expect(saved.capture.source.rect?.x).toBeCloseTo(70);
  expect(saved.capture.source.pointer?.x).toBeCloseTo(230);
  expect(saved.capture.source.pointer?.y).toBeCloseTo(150);
  expect(saved.capture.source.rect?.y).toBeCloseTo(50);
  expect(saved.capture.source.rect?.width).toBeCloseTo(160);
  expect(saved.capture.source.rect?.height).toBeCloseTo(100);
  const decorated = await app.evaluate(async () => {
    const capture = globalThis.browserTest.annotations[0].capture;
    return globalThis.browserTest.manager.decorateCapture(
      capture.png,
      capture.source.rect!,
      1,
      capture.source.viewport,
      capture.source.pointer,
    );
  });
  expect(decorated).not.toBe(saved.capture.png);
  expect(Buffer.from(decorated, 'base64').subarray(1, 4).toString()).toBe('PNG');
  await app.evaluate(async () => {
    const annotation = globalThis.browserTest.annotations[0];
    await globalThis.browserTest.manager.showCapture({ ...annotation, number: 1 });
  });
  await expect(overlay.getByRole('status')).toContainText('Saved capture');
  await expect(overlay.locator('#number')).toHaveText('1');
  await expect(overlay.locator('#pointer-badge')).toBeVisible();
  await expect(overlay.locator('#composer')).toBeHidden();
  await expect(overlay.getByText('Investigate this captured result', { exact: true })).toHaveCount(
    0,
  );
  await overlay.screenshot({ path: '.tmp/tasks/capture-no-comment-20261010/browser.png' });
});

async function nativeMarkerBounds() {
  return app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const owner = BrowserWindow.getAllWindows().find(window => !window.getParentWindow())!;
    return owner.contentView.children.flatMap((view) => {
      if (!(view instanceof WebContentsView)) return [];
      const url = view.webContents.getURL();
      if (
        !url.startsWith('data:text/html;base64,') ||
        !Buffer.from(url.split(',')[1], 'base64').toString().includes('id="marker"')
      )
        return [];
      return [view.getBounds()];
    });
  });
}

async function nativeMarkerTips() {
  return app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const owner = BrowserWindow.getAllWindows().find(window => !window.getParentWindow())!;
    const views = owner.contentView.children.filter(
      (view) =>
        view instanceof WebContentsView &&
        view.webContents.getURL().startsWith('data:text/html;base64,') &&
        Buffer.from(view.webContents.getURL().split(',')[1], 'base64')
          .toString()
          .includes('id="marker"'),
    ) as import('electron').WebContentsView[];
    return Promise.all(
      views.map(async (view) => {
        const tip = (await view.webContents.executeJavaScript(
          "document.getElementById('badge').getAttribute('d').match(/^M([^ ]+) ([^ ]+)/).slice(1,3).map(Number)",
        )) as number[];
        const bounds = view.getBounds();
        return { x: bounds.x + tip[0], y: bounds.y + tip[1] };
      }),
    );
  });
}

async function saveSelectedElement(
  tabId: string,
  point: { x: number; y: number },
  comment: string,
) {
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
    tabId,
  );
  const overlay = await pageAt(
    (page) =>
      page.url().startsWith('data:text/html;base64,') &&
      Buffer.from(page.url().split(',')[1], 'base64').toString().includes('id="layer"'),
  );
  // The reused overlay receives its live state asynchronously over IPC.
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  await overlay.mouse.move(point.x, point.y);
  await expect(overlay.locator('#rectangle')).toBeVisible();
  await overlay.mouse.click(point.x, point.y);
  await overlay.getByLabel('Area annotation comment').fill(comment);
  await overlay.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await expect(overlay.locator('#composer')).toBeHidden();
  await expect(overlay.locator('#rectangle')).toBeVisible();
  return overlay;
}

test('live hover selects a table cell and markers follow DOM geometry, sticky scrolling and zoom', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
  await external.evaluate(() => {
    document.body.innerHTML =
      '<header id="sticky" style="position:sticky;top:0;height:38px;background:#ffc;z-index:2">Sticky header</header><table style="margin-top:120px;width:500px"><tr><td id="target-cell" style="height:60px;background:#dfd">Cell result</td><td>Other cell</td></tr></table><p>End</p>';
  });
  const cell = await external.locator('#target-cell').boundingBox();
  if (!cell) throw new Error('Cell unavailable');
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
    tab.id,
  );
  const overlay = await pageAt(
    (page) =>
      page.url().startsWith('data:text/html;base64,') &&
      Buffer.from(page.url().split(',')[1], 'base64').toString().includes('id="layer"'),
  );
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  await overlay.mouse.move(cell.x + 30, cell.y + 20);
  await expect(overlay.locator('#rectangle')).toBeVisible();
  // Native hit testing is asynchronous; an initial body frame is not the requested cell frame.
  await expect
    .poll(async () => (await overlay.locator('#rectangle').boundingBox())?.height)
    .toBeCloseTo(cell.height, 0);
  await expect
    .poll(async () => (await overlay.locator('#rectangle').boundingBox())?.width)
    .toBeCloseTo(cell.width, 0);
  // The page may change after Annotate activation; capture must use the state at selection.
  await external.locator('#target-cell').evaluate((el) => {
    el.textContent = 'Updated before selection';
  });
  await overlay.mouse.click(cell.x + 30, cell.y + 20);
  await overlay.getByLabel('Area annotation comment').fill('Cell annotation');
  await overlay.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await app.evaluate((_electron, id) => globalThis.browserTest.manager.select(id), tab.id);
  await saveSelectedElement(tab.id, { x: 30, y: 20 }, 'Sticky annotation');
  await app.evaluate((_electron, id) => globalThis.browserTest.manager.select(id), tab.id);
  const annotations = await app.evaluate(() => globalThis.browserTest.annotations);
  expect(annotations[0].capture.source.elementAnchor).toMatchObject({
    tag: 'TD',
    id: 'target-cell',
  });
  expect(annotations[1].capture.source.elementAnchor).toMatchObject({
    tag: 'HEADER',
    id: 'sticky',
  });
  expect(annotations[0].capture.source.pageId).toBeTruthy();
  expect(annotations[0].capture.source.stateHash).toBeTruthy();
  expect(annotations[0].capture.source.pointer).toEqual({ x: cell.x + 30, y: cell.y + 20 });
  await app.evaluate(() =>
    globalThis.browserTest.manager.setAnnotations(
      'artifact-a',
      globalThis.browserTest.annotations.map((a, index) => ({
        id: 'note-' + index,
        number: index + 1,
        capture: a.capture,
      })),
    ),
  );
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(2);
  const initialTips = await nativeMarkerTips();
  expect(initialTips[0].x).toBeCloseTo(20 + cell.x + 30);
  expect(initialTips[0].y).toBeCloseTo(80 + cell.y + 20);
  const initial = await nativeMarkerBounds();
  await external.evaluate(() => window.scrollTo(0, 50));
  await expect.poll(async () => (await nativeMarkerBounds())[0]?.y).toBeLessThan(initial[0].y - 35);
  const scrolled = await nativeMarkerBounds();
  expect(scrolled[1].y).toBeLessThanOrEqual(initial[1].y);
  expect(scrolled[1].y).toBeGreaterThan(initial[1].y - 15);
  const stickyTip = (await nativeMarkerTips())[1];
  await external.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(1);
  expect((await nativeMarkerTips())[0].x).toBeCloseTo(stickyTip.x);
  expect((await nativeMarkerTips())[0].y).toBeCloseTo(stickyTip.y);
  await external.evaluate(() => window.scrollTo(0, 50));
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(2);
  // Native views can be recreated in a different order: compare the content tip by position.
  await expect
    .poll(async () => (await nativeMarkerTips()).find((tip) => tip.y > stickyTip.y + 20)?.y)
    .toBeCloseTo(initialTips[0].y - 50);
  await app.evaluate(
    ({ webContents }, url) =>
      webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === url)!
        .setZoomFactor(1.25),
    url,
  );
  // Chromium quantizes the native view and page zoom to display pixels.
  const expectedZoomedX = 20 + (cell.x + 30) * 1.25;
  await expect.poll(async () => {
    const tip = (await nativeMarkerTips()).find((tip) => tip.y > stickyTip.y + 20);
    return tip ? Math.abs(tip.x - expectedZoomedX) : Infinity;
  }).toBeLessThanOrEqual(1);
  // Changing the semantic state removes live markers rather than pretending old coordinates remain valid.
  await external.locator('#target-cell').evaluate((el) => {
    el.textContent = 'Different result';
  });
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(0);
});

test('queued overlay pointer traffic retires when selection closes without acting on a later tool', async ({ diagnostics }) => {
  const tab = await app.evaluate(async (_electron, url) =>
    globalThis.browserTest.manager.open({ artifactId: 'artifact-a', projectId: 'project-a', url }), url);
  const external = await pageAt(page => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page', exact: true })).toBeVisible();
  const activate = () => app.evaluate(async ({ BrowserWindow }, id) => {
    const [width, height] = BrowserWindow.getAllWindows().find(window => !window.getParentWindow())!.getContentSize();
    // The fixture shell's load can still be finishing when its first window
    // becomes observable. Project real native bounds explicitly before Annotate.
    globalThis.browserTest.manager.setVisibleViews([{ viewId: 'queued-pointer-pane',
      tabId: id, active: true, bounds: { x: 20, y: 80, width: width - 60, height: height - 160 } }]);
    await globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' });
  }, tab.id);
  await activate();
  const overlay = await pageAt(page => page.url().startsWith('data:text/html;base64,'));
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  await app.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(contents => contents.getURL() === url)!;
    const original = contents.executeJavaScriptInIsolatedWorld.bind(contents);
    const gate = { held: false, release: (() => {}) as () => void };
    Object.assign(globalThis, { queuedOverlayProbe: gate });
    contents.executeJavaScriptInIsolatedWorld = async (...args) => {
      const result = await original(...args);
      if (!gate.held && args[1].some(script => script.code.includes('document.elementFromPoint('))) {
        gate.held = true;
        await new Promise<void>(resolve => { gate.release = resolve; });
      }
      return result;
    };
  }, url);
  await overlay.evaluate(() => {
    const bridge = (window as unknown as { projectorCapture: { invoke(action: string, value: unknown): Promise<unknown> } }).projectorCapture;
    const results = ['pending', 'pending'];
    Object.assign(window, { queuedHoverResults: results });
    for (let index = 0; index < 2; index++)
      void bridge.invoke('hover', { x: 60 + index, y: 50 }).then(
        () => { results[index] = 'resolved'; },
        error => { results[index] = String(error); },
      );
  });
  await expect.poll(() => app.evaluate(() =>
    (globalThis as unknown as { queuedOverlayProbe: { held: boolean } }).queuedOverlayProbe.held)).toBe(true);
  await app.evaluate(() => globalThis.browserTest.manager.select(null));
  await app.evaluate(() =>
    (globalThis as unknown as { queuedOverlayProbe: { release(): void } }).queuedOverlayProbe.release());
  await expect.poll(() => overlay.evaluate(() =>
    (window as unknown as { queuedHoverResults: string[] }).queuedHoverResults)).toEqual([
      'Error: CAPTURE_CHANGED: The annotation tool was closed. Select again.',
      'Error: CAPTURE_CHANGED: The annotation tool was closed. Select again.',
    ]);
  expect(await app.evaluate(() => globalThis.browserTest.manager.snapshot().annotating)).toBe(false);
  expect(await app.evaluate(() => globalThis.browserTest.drafts.length)).toBe(0);

  await activate();
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  diagnostics.phase('invalid-active-pointer');
  diagnostics.expect({ role: 'main', kind: 'console-error', phase: 'invalid-active-pointer',
    message: /^Error occurred in handler for 'projector:browser-overlay': Error: INVALID_POINTER\n[\s\S]*$/, count: 1 });
  const invalid = await overlay.evaluate(async () => {
    const bridge = (window as unknown as { projectorCapture: { invoke(action: string, value: unknown): Promise<unknown> } }).projectorCapture;
    try { await bridge.invoke('hover', { x: 100000, y: 50 }); return 'resolved'; }
    catch (error) { return String(error); }
  });
  expect(invalid).toContain('INVALID_POINTER');
  diagnostics.phase('test');
  const fresh = await overlay.evaluate(async () =>
    (window as unknown as { projectorCapture: { invoke(action: string, value: unknown): Promise<{ rect?: { width: number } }> } }).projectorCapture.invoke('hover', { x: 60, y: 50 }));
  expect(fresh.rect!.width).toBeGreaterThan(0);
});

test('history push/replace/hash entries hide mismatched markers and back recovers matching page identity', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
  await saveSelectedElement(tab.id, { x: 60, y: 50 }, 'History marker');
  await app.evaluate((_electron, id) => globalThis.browserTest.manager.select(id), tab.id);
  const annotation = await app.evaluate(() => globalThis.browserTest.annotations[0]);
  await app.evaluate(
    (_electron, annotation) =>
      globalThis.browserTest.manager.setAnnotations('artifact-a', [
        { id: 'history-note', number: 1, capture: annotation.capture },
      ]),
    annotation,
  );
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(1);
  const original = annotation.capture.source;
  await external.evaluate(() => history.pushState({ step: 1 }, '', location.pathname + '?step=1'));
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(0);
  await expect
    .poll(() => app.evaluate(() => globalThis.browserTest.manager.snapshot().tabs[0].pageId))
    .not.toBe(original.pageId);
  const pushed = await app.evaluate(() => globalThis.browserTest.manager.snapshot().tabs[0]);
  expect(pushed.pageId).not.toBe(original.pageId);
  expect(pushed.stateHash).not.toBe(original.stateHash);
  await external.evaluate(() => history.replaceState({ step: 2 }, '', location.href));
  await expect
    .poll(() => app.evaluate(() => globalThis.browserTest.manager.snapshot().tabs[0].stateHash))
    .not.toBe(pushed.stateHash);
  const replaced = await app.evaluate(() => globalThis.browserTest.manager.snapshot().tabs[0]);
  expect(replaced.pageId).toBe(pushed.pageId);
  await external.evaluate(() => history.back());
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(1);
  await external.evaluate(() => {
    location.hash = 'section-two';
  });
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(0);
  await external.evaluate(() => history.back());
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(1);
  const restored = await app.evaluate(() => globalThis.browserTest.manager.snapshot().tabs[0]);
  expect(restored.pageId).toBe(original.pageId);
  expect(restored.stateHash).toBe(original.stateHash);
  // An unselected tool contains no private composer and can safely yield to a requested document.
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
    tab.id,
  );
  await app.evaluate(() => globalThis.browserTest.manager.select(null));
  expect(await app.evaluate(() => globalThis.browserTest.manager.snapshot().annotating)).toBe(
    false,
  );
});

test('arbitrary regions retain document coordinates on stable layout and hide after layout or sticky scroll changes', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await external.evaluate(() => {
    document.body.innerHTML =
      '<div id="region" style="margin-top:220px;height:100px;background:#dfd">Region</div>';
    const style = document.createElement('style');
    style.id = 'geometry-style';
    style.textContent = '#region{width:400px}';
    document.head.append(style);
  });
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
    tab.id,
  );
  const overlay = await pageAt(
    (page) =>
      page.url().startsWith('data:text/html;base64,') &&
      Buffer.from(page.url().split(',')[1], 'base64').toString().includes('id="layer"'),
  );
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  await overlay.mouse.move(40, 240);
  await overlay.mouse.down();
  await overlay.mouse.move(180, 285);
  await overlay.mouse.up();
  await overlay.getByLabel('Area annotation comment').fill('Region annotation');
  await overlay.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await app.evaluate((_electron, id) => globalThis.browserTest.manager.select(id), tab.id);
  const region = await app.evaluate(() => globalThis.browserTest.annotations[0]);
  expect(region.capture.source.elementAnchor).toBeUndefined();
  await app.evaluate(
    (_electron, annotation) =>
      globalThis.browserTest.manager.setAnnotations('artifact-a', [
        { id: 'region-note', number: 1, capture: annotation.capture },
      ]),
    region,
  );
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(1);
  const original = (await nativeMarkerBounds())[0];
  await external.evaluate(() => window.scrollTo(0, 60));
  await expect.poll(async () => (await nativeMarkerBounds())[0]?.y).toBeLessThan(original.y - 45);
  // Head CSS changes geometry without changing the semantic HTML of the body.
  await external.evaluate(() => {
    document.getElementById('geometry-style')!.textContent = '#region{width:200px}';
  });
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(0);
  await external.evaluate(() => {
    window.scrollTo(0, 0);
    document.body.innerHTML =
      '<header id="fixed-area" style="position:sticky;top:0;height:50px;background:#ffd">Sticky region</header><div style="height:1700px">Scroll</div>';
  });
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
    tab.id,
  );
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  await overlay.mouse.move(30, 15);
  await overlay.mouse.down();
  await overlay.mouse.move(170, 40);
  await overlay.mouse.up();
  await overlay.getByLabel('Area annotation comment').fill('Sticky arbitrary region');
  await overlay.getByRole('button', { name: 'Save annotation', exact: true }).click();
  await app.evaluate((_electron, id) => globalThis.browserTest.manager.select(id), tab.id);
  const sticky = await app.evaluate(() => globalThis.browserTest.annotations[1]);
  await app.evaluate(
    (_electron, annotation) =>
      globalThis.browserTest.manager.setAnnotations('artifact-a', [
        { id: 'sticky-region', number: 2, capture: annotation.capture },
      ]),
    sticky,
  );
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(1);
  await external.evaluate(() => window.scrollTo(0, 70));
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(0);
});

test('same-URL push after back creates a new entry binding even when URL, state and DOM match', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
  await external.evaluate(() => history.pushState(null, '', location.href));
  await saveSelectedElement(tab.id, { x: 60, y: 50 }, 'Forward branch annotation');
  await app.evaluate((_electron, id) => globalThis.browserTest.manager.select(id), tab.id);
  const annotation = await app.evaluate(() => globalThis.browserTest.annotations[0]);
  await app.evaluate(
    (_electron, annotation) =>
      globalThis.browserTest.manager.setAnnotations('artifact-a', [
        { id: 'branch-note', number: 1, capture: annotation.capture },
      ]),
    annotation,
  );
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(1);
  await external.evaluate(() => history.back());
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(0);
  await external.evaluate(() => history.pushState(null, '', location.href));
  await expect
    .poll(() => app.evaluate(() => globalThis.browserTest.manager.snapshot().tabs[0].pageId))
    .not.toBe(annotation.capture.source.pageId);
  await expect
    .poll(() => app.evaluate(() => globalThis.browserTest.manager.snapshot().tabs[0].stateHash))
    .toBe(annotation.capture.source.stateHash);
  expect((await nativeMarkerBounds()).length).toBe(0);
});

for (const change of ['content', 'layout'] as const) {
  test(`a single ${change} update during capture retries with matching snapshot context`, async () => {
    const tab = await app.evaluate(
      async (_electron, url) =>
        globalThis.browserTest.manager.open({
          artifactId: 'artifact-a',
          projectId: 'project-a',
          url,
        }),
      url,
    );
    const external = await pageAt((page) => page.url() === url);
    await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
    await app.evaluate(
      ({ webContents }, { url, change }) => {
        const contents = webContents.getAllWebContents().find((c) => c.getURL() === url)!;
        const capture = contents.capturePage.bind(contents);
        let count = 0;
        contents.capturePage = async () => {
          const image = await capture();
          if (++count === 1)
            await contents.executeJavaScript(
              change === 'content'
                ? "document.querySelector('h1').textContent='Updated result'"
                : "document.querySelector('h1').style.transform='translateY(10px)'",
            );
          return image;
        };
      },
      { url, change },
    );
    await app.evaluate(
      async (_electron, id) =>
        globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
      tab.id,
    );
    const overlay = await pageAt((page) => page.url().startsWith('data:text/html;base64,'));
    await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
    await overlay.mouse.click(60, 50);
    await expect(overlay.getByLabel('Area annotation comment')).toBeVisible();
    const draft = (await app.evaluate(() => globalThis.browserTest.drafts.at(-1))) as {
      capture: { source: { stateHash: string; rect: { y: number } } };
    };
    const state = await app.evaluate(() => globalThis.browserTest.manager.snapshot().tabs[0]);
    expect(draft.capture.source.stateHash).toBe(state.stateHash);
    if (change === 'content')
      await expect(external.getByRole('heading', { name: 'Updated result' })).toBeVisible();
    else {
      const heading = await external.getByRole('heading').boundingBox();
      expect(draft.capture.source.rect.y).toBeCloseTo(heading!.y, 0);
    }
    expect(await app.evaluate(() => globalThis.browserTest.annotations.length)).toBe(0);
  });
}

test('unrelated continuous updates do not prevent capturing a stable selected element', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
  await app.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((c) => c.getURL() === url)!;
    const capture = contents.capturePage.bind(contents);
    let count = 0;
    contents.capturePage = async () => {
      const image = await capture();
      await contents.executeJavaScript(
        'document.body.dataset.tick=' + JSON.stringify(String(++count)),
      );
      return image;
    };
  }, url);
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
    tab.id,
  );
  const overlay = await pageAt((page) => page.url().startsWith('data:text/html;base64,'));
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  await overlay.mouse.click(60, 50);
  await expect(overlay.getByLabel('Area annotation comment')).toBeVisible();
  const draft = (await app.evaluate(() => globalThis.browserTest.drafts.at(-1))) as {
    capture: { png: string; source: { pointer: { x: number; y: number } } };
  };
  expect(draft.capture.source.pointer).toEqual({ x: 60, y: 50 });
  expect(Buffer.from(draft.capture.png, 'base64').subarray(1, 4).toString()).toBe('PNG');
});

test('disposing a browser owner retires IPC from an overlay whose native close is still pending', async () => {
  const tab = await app.evaluate(async (_electron, url) =>
    globalThis.browserTest.manager.open({artifactId:'artifact-a',projectId:'project-a',url}),url);
  const external = await pageAt(page => page.url() === url);
  await expect(external.getByRole('heading',{name:'External page',exact:true})).toBeVisible();
  await app.evaluate(async (_electron,id) => globalThis.browserTest.manager.command({tabId:id,action:'annotate'}),tab.id);
  const overlay = await pageAt(page => page.url().startsWith('data:text/html;base64,'));
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  await app.evaluate(({webContents}) => {
    const contents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith('data:text/html;base64,'))!;
    const close = contents.close.bind(contents);
    contents.close = () => {};
    Object.assign(globalThis,{releaseRetiredOverlay:close});
    globalThis.browserTest.manager.dispose();
  });
  try {
    expect(await app.evaluate(({ BrowserWindow, WebContentsView }) =>
      BrowserWindow.getAllWindows().flatMap(window => window.contentView.children.filter(
        view => view instanceof WebContentsView && view.webContents !== window.webContents,
      )).length,
    )).toBe(0);
    const result = await overlay.evaluate(async () => {
      const bridge = (window as unknown as {projectorCapture:{invoke(action:string,value:unknown):Promise<unknown>}}).projectorCapture;
      try { await bridge.invoke('hover',{x:60,y:50}); return 'resolved'; }
      catch(error) { return String(error); }
    });
    expect(result).toBe('Error: CAPTURE_CHANGED: The annotation tool was closed. Select again.');
    expect(await app.evaluate(() => globalThis.browserTest.drafts.length)).toBe(0);
  } finally {
    await app.evaluate(() => (globalThis as unknown as {releaseRetiredOverlay():void}).releaseRetiredOverlay());
    await expect.poll(() => overlay.isClosed()).toBe(true);
  }
});

test('same-document history updates during tool activation do not cancel the uncaptured annotator', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
  // Astro and other routers maintain scroll metadata through replaceState. Emit
  // these real native events while the trusted overlay is initially loading.
  await external.evaluate(() => {
    const timer = setInterval(
      () => history.replaceState({ scroll: scrollY }, '', location.href),
      5,
    );
    setTimeout(() => clearInterval(timer), 500);
  });
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
    tab.id,
  );
  const overlay = await pageAt((page) => page.url().startsWith('data:text/html;base64,'));
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  expect(await app.evaluate(() => globalThis.browserTest.manager.snapshot().annotating)).toBe(true);
});

test('continuous selected-content changes stay recoverable and do not reject the Electron IPC handler', async () => {
  const stderr: string[] = [];
  app.process().stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
  await app.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((c) => c.getURL() === url)!;
    const capture = contents.capturePage.bind(contents);
    let count = 0;
    contents.capturePage = async () => {
      const image = await capture();
      await contents.executeJavaScript(
        "document.querySelector('h1').textContent=" + JSON.stringify('Result ' + ++count),
      );
      if (count === 3) contents.capturePage = capture;
      return image;
    };
  }, url);
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
    tab.id,
  );
  const overlay = await pageAt((page) => page.url().startsWith('data:text/html;base64,'));
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  await overlay.mouse.click(60, 50);
  await expect(overlay.getByRole('status')).toContainText('CAPTURE_CHANGED');
  await expect(overlay.getByLabel('Area annotation comment')).toBeHidden();
  expect(await app.evaluate(() => globalThis.browserTest.drafts.length)).toBe(0);
  expect(await app.evaluate(() => globalThis.browserTest.manager.snapshot().annotating)).toBe(true);
  await expect(external.getByRole('heading')).toHaveText('Result 3');
  await expect(overlay.locator('#rectangle')).toBeHidden();
  await overlay.mouse.click(60, 50);
  await expect(overlay.getByLabel('Area annotation comment')).toBeVisible();
  expect(await app.evaluate(() => globalThis.browserTest.drafts.length)).toBe(1);
  expect(stderr.join('')).not.toContain(
    "Error occurred in handler for 'projector:browser-overlay'",
  );
});

test('capture retries never silently select a replacement element', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
  await app.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((c) => c.getURL() === url)!;
    const capture = contents.capturePage.bind(contents);
    contents.capturePage = async () => {
      const image = await capture();
      await contents.executeJavaScript(
        "document.querySelector('h1').outerHTML='<button style=\"width:300px;height:120px\">Replacement</button>'",
      );
      contents.capturePage = capture;
      return image;
    };
  }, url);
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
    tab.id,
  );
  const overlay = await pageAt((page) => page.url().startsWith('data:text/html;base64,'));
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  await overlay.mouse.click(60, 50);
  await expect(overlay.getByRole('status')).toContainText('The selected element changed');
  await expect(overlay.getByLabel('Area annotation comment')).toBeHidden();
  expect(await app.evaluate(() => globalThis.browserTest.drafts.length)).toBe(0);
});

test('zoom changing after viewport capture rejects the selection without creating a private composer', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
  await app.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    const capture = contents.capturePage.bind(contents);
    contents.capturePage = async () => {
      const image = await capture();
      contents.setZoomFactor(1.5);
      return image;
    };
  }, url);
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
    tab.id,
  );
  const overlay = await pageAt(
    (page) =>
      page.url().startsWith('data:text/html;base64,') &&
      Buffer.from(page.url().split(',')[1], 'base64').toString().includes('id="layer"'),
  );
  await overlay.mouse.click(60, 50);
  await expect(overlay.getByRole('status')).toContainText('CAPTURE_CHANGED');
  await expect(overlay.getByLabel('Area annotation comment')).toBeHidden();
  expect(await app.evaluate(() => globalThis.browserTest.drafts.length)).toBe(0);
});

test('table markers hide when their pointer is clipped, even while the cell remains visible, and return with content', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await external.evaluate(() => {
    document.body.innerHTML =
      '<h1>Outside the table</h1><div id="table-viewport" style="margin-top:30px;width:450px;height:140px;overflow:auto"><table style="border-collapse:collapse;width:820px"><tr><td style="height:60px">First row</td></tr><tr><td id="nested-cell" style="height:60px;background:#dfd">Chosen nested cell</td></tr><tr><td style="height:60px">Third row</td></tr><tr><td style="height:60px">Fourth row</td></tr><tr><td style="height:60px">Fifth row</td></tr></table></div>';
  });
  const cell = await external.locator('#nested-cell').boundingBox();
  if (!cell) throw new Error('Cell unavailable');
  await saveSelectedElement(tab.id, { x: cell.x + 30, y: cell.y + 20 }, 'Nested cell annotation');
  await app.evaluate((_electron, id) => globalThis.browserTest.manager.select(id), tab.id);
  const annotation = await app.evaluate(() => globalThis.browserTest.annotations[0]);
  expect(annotation.capture.source.elementAnchor).toMatchObject({ tag: 'TD', id: 'nested-cell' });
  await app.evaluate(
    (_electron, annotation) =>
      globalThis.browserTest.manager.setAnnotations('artifact-a', [
        { id: 'nested-note', number: 1, capture: annotation.capture },
      ]),
    annotation,
  );
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(1);
  const original = (await nativeMarkerBounds())[0];
  const originalTip = (await nativeMarkerTips())[0];
  const viewport = await external.locator('#table-viewport').boundingBox();
  if (!viewport) throw new Error('Table viewport unavailable');
  await external.locator('#table-viewport').evaluate((el) => {
    el.scrollTop = 20;
  });
  await expect.poll(async () => (await nativeMarkerBounds())[0]?.y).toBeLessThan(original.y - 15);
  await external.locator('#table-viewport').evaluate(
    (el, scroll) => {
      el.scrollTop = scroll;
    },
    cell.y + 20 - viewport.y + 8,
  );
  const partial = await external.locator('#nested-cell').boundingBox();
  if (!partial) throw new Error('Partially clipped cell unavailable');
  expect(partial.y).toBeLessThan(viewport.y);
  expect(partial.y + partial.height).toBeGreaterThan(viewport.y);
  // The element still paints inside the viewport, but its original pointer does not.
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(0);
  await external.locator('#table-viewport').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(1);
  await external.locator('#table-viewport').evaluate((el) => {
    el.scrollLeft = 80;
  });
  const horizontal = await external.locator('#nested-cell').boundingBox();
  if (!horizontal) throw new Error('Horizontally clipped cell unavailable');
  expect(horizontal.x).toBeLessThan(viewport.x);
  expect(horizontal.x + horizontal.width).toBeGreaterThan(viewport.x);
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(0);
  await external.locator('#table-viewport').evaluate((el) => {
    el.scrollLeft = 0;
  });
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(1);
  await external.locator('#table-viewport').evaluate((el) => {
    el.scrollTop = 140;
  });
  // The clipped cell still has a positive viewport rect, but no pixels are visible.
  expect((await external.locator('#nested-cell').boundingBox())?.y).toBeGreaterThan(0);
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(0);
  await external.locator('#table-viewport').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(1);
  await external.evaluate((offset) => window.scrollTo(0, offset), cell.y + cell.height + 20);
  expect((await external.locator('#nested-cell').boundingBox())!.y + cell.height).toBeLessThan(0);
  await expect.poll(async () => (await nativeMarkerBounds()).length).toBe(0);
  await external.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => (await nativeMarkerTips())[0]?.y).toBeCloseTo(originalTip.y);
  expect((await nativeMarkerTips())[0]?.x).toBeCloseTo(originalTip.x);
});

test('closing a native browser respects beforeunload and unregisters only on destruction', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
  await external.evaluate(() => {
    window.onbeforeunload = () => '';
  });
  const cancelled = await app.evaluate(async ({ dialog }, id) => {
    dialog.showMessageBoxSync = () => 1;
    return globalThis.browserTest.manager.command({ tabId: id, action: 'close' });
  }, tab.id);
  expect(cancelled).toMatchObject({ cancelled: true, activeTabId: tab.id });
  expect(cancelled.tabs.map((t) => t.id)).toContain(tab.id);
  expect(external.isClosed()).toBe(false);
  const closed = await app.evaluate(
    async ({ dialog, webContents }, { id, url }) => {
      const contents = webContents.getAllWebContents().find((value) => value.getURL() === url)!;
      dialog.showMessageBoxSync = () => 0;
      const state = await globalThis.browserTest.manager.command({ tabId: id, action: 'close' });
      return { ...state, destroyed: contents.isDestroyed() };
    },
    { id: tab.id, url },
  );
  expect(closed).toMatchObject({ cancelled: false, activeTabId: null, tabs: [], destroyed: true });
  // Electron destruction and the Playwright page notification use separate channels.
  await expect.poll(() => external.isClosed()).toBe(true);
  await app.evaluate(() => {
    globalThis.browserTest.manager.dispose();
    globalThis.browserTest.manager.dispose();
  });
});

test('external webContents destruction unregisters tabs and dispose is idempotent', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
  await app.evaluate(({ webContents }, url) => {
    webContents
      .getAllWebContents()
      .find((c) => c.getURL() === url)!
      .close();
  }, url);
  await expect
    .poll(() => app.evaluate(() => globalThis.browserTest.manager.snapshot().tabs))
    .toEqual([]);
  await app.evaluate(() => {
    globalThis.browserTest.manager.dispose();
    globalThis.browserTest.manager.dispose();
  });
  expect(tab.id).toBeTruthy();
});

test('browser finishComment flushes latest text, cancels empty and blocks transition on failed private write', async ({diagnostics}) => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading', { name: 'External page' })).toBeVisible();
  const select = async () => {
    await app.evaluate(
      async (_electron, id) =>
        globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
      tab.id,
    );
    const overlay = await pageAt((page) => page.url().startsWith('data:text/html;base64,'));
    await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
    await overlay.mouse.move(80, 80);
    await overlay.mouse.down();
    await overlay.mouse.move(220, 150);
    await overlay.mouse.up();
    await expect(overlay.getByLabel('Area annotation comment')).toBeVisible();
    return overlay;
  };
  const first = await select();
  await first.getByLabel('Area annotation comment').fill('Latest text before switching');
  await app.evaluate(async () => {
    await globalThis.browserTest.manager.finishComment();
    globalThis.browserTest.manager.select(null);
  });
  expect(
    await app.evaluate(() => globalThis.browserTest.annotations.map((a) => a.comment)),
  ).toEqual(['Latest text before switching']);
  expect(await app.evaluate(() => globalThis.browserTest.drafts.at(-1))).toBeNull();
  await select();
  await app.evaluate(async () => globalThis.browserTest.manager.finishComment());
  expect(await app.evaluate(() => globalThis.browserTest.annotations.length)).toBe(1);
  expect(await app.evaluate(() => globalThis.browserTest.drafts.at(-1))).toBeNull();
  const failed = await select();
  await app.evaluate(() => {
    globalThis.browserTest.failDraft = true;
  });
  diagnostics.phase('browser-draft-denied');
  diagnostics.expect({role:'main',kind:'console-error',phase:'browser-draft-denied',message:/^Error occurred in handler for 'projector:browser-overlay': Error: DISK_WRITE_FAILED\b/,count:1});
  await failed.getByLabel('Area annotation comment').fill('Keep on disk failure');
  const message = await app.evaluate(async () => {
    try {
      await globalThis.browserTest.manager.finishComment();
      globalThis.browserTest.manager.select(null);
      return 'switched';
    } catch (error) {
      return (error as Error).message;
    }
  });
  expect(message).toContain('DISK_WRITE_FAILED');
  await expect(failed.getByLabel('Area annotation comment')).toHaveValue('Keep on disk failure');
  expect(await app.evaluate(() => globalThis.browserTest.manager.snapshot().activeTabId)).toBe(
    tab.id,
  );
  expect(await app.evaluate(() => globalThis.browserTest.annotations.length)).toBe(1);
  await app.evaluate(() => {
    globalThis.browserTest.failDraft = false;
  });
  await failed.mouse.click(10, 10);
  await expect(failed.locator('#composer')).toBeHidden();
  await expect(failed.locator('#rectangle')).toBeVisible();
  expect(
    await app.evaluate(() => globalThis.browserTest.annotations.map((a) => a.comment)),
  ).toEqual(['Latest text before switching', 'Keep on disk failure']);
});

// Decode the captured artifact, not a second screenshot or the live DOM. Exact fixture
// colors at interior points catch valid-but-unrelated, wrong-tab and stale PNGs.
async function expectViewportPixels(png: string, background: number[]) {
  const pixels = await app.evaluate(({ nativeImage }, png) => {
    const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'));
    const size = image.getSize();
    const bitmap = image.toBitmap();
    return [
      [100, 300],
      [720, 420],
      [100, 80],
    ].map(([x, y]) => {
      const offset =
        (Math.floor((y * size.height) / 540) * size.width + Math.floor((x * size.width) / 840)) * 4;
      // Native bitmap uses BGRA on the supported macOS/Linux platforms.
      return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset], bitmap[offset + 3]];
    });
  }, png);
  expect(pixels).toEqual([background, [19, 67, 211, 255], [113, 51, 149, 255]]);
}

test('captured viewport pixels identify the current page and reject wrong or stale frames', async () => {
  const captures: string[] = [];
  for (const state of [1, 2]) {
    const pageUrl = `${url}pixels?state=${state}`;
    const tab = await app.evaluate(
      async (_, url) =>
        globalThis.browserTest.manager.open({
          artifactId: 'artifact-a',
          projectId: 'project-a',
          url,
        }),
      pageUrl,
    );
    const external = await pageAt((page) => page.url() === pageUrl);
    await expect(external.getByRole('heading')).toHaveText(`State ${state}`);
    await external.evaluate(() => window.scrollTo(0, 120));
    await app.evaluate(
      async (_, id) => globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
      tab.id,
    );
    const overlay = await pageAt((page) => page.url().startsWith('data:text/html;base64,'));
    await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
    await overlay.mouse.move(50, 50);
    await overlay.mouse.down();
    await overlay.mouse.move(160, 110);
    await overlay.mouse.up();
    await overlay.getByLabel('Area annotation comment').fill(`State ${state}`);
    await overlay.getByLabel('Area annotation comment').press('Enter');
    await expect
      .poll(() => app.evaluate(() => globalThis.browserTest.annotations.length))
      .toBe(state);
    const capture = await app.evaluate(() => globalThis.browserTest.annotations.at(-1)!.capture);
    expect(capture.source).toMatchObject({ url: pageUrl, scroll: { x: 0, y: 120 } });
    const expected = state === 1 ? [23, 171, 61, 255] : [205, 44, 71, 255];
    await expectViewportPixels(capture.png, expected);
    captures.push(capture.png);
    await app.evaluate(async () => globalThis.browserTest.manager.finishComment());
  }
  // Sensitivity checks exercise exactly the consumer oracle above. Valid PNG encoding
  // and dimensions alone must never accept another page or an earlier state.
  await expect(expectViewportPixels(captures[0], [205, 44, 71, 255])).rejects.toThrow();
  const wrong = await app.evaluate(({ nativeImage }) => {
    const bitmap = Buffer.alloc(840 * 540 * 4, 255);
    return nativeImage
      .createFromBitmap(bitmap, { width: 840, height: 540 })
      .toPNG()
      .toString('base64');
  });
  await expect(expectViewportPixels(wrong, [205, 44, 71, 255])).rejects.toThrow();
});

test('trusted overlay forwards repeated wheel to page and nested sticky table', async () => {
  const tab = await app.evaluate(
    async (_, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'artifact-a',
        projectId: 'project-a',
        url,
      }),
    url,
  );
  const external = await pageAt((page) => page.url() === url);
  await expect(external.getByRole('heading')).toBeVisible();
  await external.evaluate(() => {
    document.body.style.margin = '0';
    document.body.insertAdjacentHTML(
      'afterbegin',
      `<div id="nested" style="position:fixed;left:80px;top:100px;width:500px;height:260px;overflow:auto;z-index:10;background:white">
      <table style="border-collapse:collapse;width:100%"><thead style="position:sticky;top:0;background:yellow"><tr><th>Sticky heading</th></tr></thead>
      <tbody>${Array.from({ length: 70 }, (_, i) => `<tr><td style="height:40px">Row ${i}</td></tr>`).join('')}</tbody></table></div>`,
    );
    const state = window as unknown as { wheelEvents: boolean[] };
    state.wheelEvents = [];
    addEventListener('wheel', (event) => state.wheelEvents.push(event.isTrusted));
  });
  await app.evaluate(
    async (_, id) => globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
    tab.id,
  );
  const overlay = await pageAt((page) => page.url().startsWith('data:text/html;base64,'));
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  for (const target of ['page', 'nested'] as const) {
    // Chromium groups wheel events into a gesture for up to 500ms. Start a
    // separate gesture when switching from the page to the nested scroller.
    if (target === 'nested') await overlay.waitForTimeout(550);
    await overlay.mouse.move(target === 'page' ? 740 : 250, target === 'page' ? 450 : 200);
    const scroll = () =>
      external.evaluate(
        (target) =>
          target === 'page' ? window.scrollY : document.getElementById('nested')!.scrollTop,
        target,
      );
    for (let cycle = 0; cycle < 2; cycle++) {
      const before = await scroll();
      await overlay.mouse.wheel(0, 350);
      await expect.poll(scroll).toBeGreaterThan(before + 100);
      const down = await scroll();
      if (target === 'nested') {
        const heading = await external.locator('th').boundingBox();
        expect(heading!.y).toBeCloseTo(100, 0);
      }
      await overlay.mouse.wheel(0, -350);
      await expect.poll(scroll).toBeLessThan(down - 100);
      if (target === 'nested') {
        const heading = await external.locator('th').boundingBox();
        expect(heading!.y).toBeCloseTo(100, 0);
      }
    }
  }
  const events = await external.evaluate(
    () => (window as unknown as { wheelEvents: boolean[] }).wheelEvents,
  );
  expect(events).toHaveLength(8);
  expect(events.every(Boolean)).toBe(true);
  // Deliberately drop wheel at the real BrowserManager -> webContents boundary.
  // The same scroll oracle must reject a transport that reports success but delivers no input.
  await app.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((value) => value.getURL() === url)!;
    const original = contents.sendInputEvent.bind(contents);
    contents.sendInputEvent = (event) => {
      if (event.type !== 'mouseWheel') original(event);
    };
  }, url);
  const before = await external.evaluate(() => document.getElementById('nested')!.scrollTop);
  await overlay.mouse.wheel(0, 350);
  await expect(
    expect
      .poll(() => external.evaluate(() => document.getElementById('nested')!.scrollTop), {
        timeout: 400,
      })
      .toBeGreaterThan(before + 100),
  ).rejects.toThrow();
});
