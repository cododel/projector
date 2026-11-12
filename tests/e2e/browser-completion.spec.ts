import {
  test,
  expect,
  electron,
  type ElectronApplication,
  type Page,
} from './test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';

let app: ElectronApplication;
let root: string;
let server: Server;
let url: string;
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bp-browser-'));
  server = createServer((request, response) => {
    if (request.url === '/download') {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', 'attachment; filename="fixture.txt"');
      response.end('Download fixture bytes');
      return;
    }
    if (request.url === '/slow') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.write('<h1>Loading fixture</h1>');
      setTimeout(() => response.end('<p>Complete</p>'), 750).unref();
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><title>Browser fixture</title><style>body{min-height:2000px;background:#eef}h1{background:#ffc;padding:25px}</style><h1>External page</h1><a href="/next">Next page</a><p>' +
        request.url +
        '</p><button onclick="window.open(\'/popup\')">Open popup</button><a href="/download">Download</a><a target="_blank" href="/background-popup">Background popup</a>',
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

test('browser zoom is bounded and clearing a profile preserves the other project', async () => {
  const first = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({ artifactId: 'a', projectId: 'a', url }),
    url,
  );
  const page = await pageAt((p) => p.url() === url);
  await page.evaluate(() => {
    document.cookie = 'project=one;path=/';
  });
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'zoom', zoomFactor: 2 }),
    first.id,
  );
  expect(
    (await app.evaluate(() => globalThis.browserTest.manager.snapshot())).tabs[0].zoomFactor,
  ).toBe(2);
  await expect(
    app.evaluate(
      async (_electron, id) =>
        globalThis.browserTest.manager.command({ tabId: id, action: 'zoom', zoomFactor: 2.1 }),
      first.id,
    ),
  ).rejects.toThrow('INVALID_ZOOM');
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'zoom-reset' }),
    first.id,
  );
  expect(
    (await app.evaluate(() => globalThis.browserTest.manager.snapshot())).tabs[0].zoomFactor,
  ).toBe(1);
  await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({ artifactId: 'b', projectId: 'b', url: url + 'other' }),
    url,
  );
  const other = await pageAt((p) => p.url() === url + 'other');
  await other.evaluate(() => {
    document.cookie = 'project=two;path=/';
  });
  const result = await app.evaluate(async () =>
    globalThis.browserTest.manager.clearProjectProfile('a'),
  );
  expect(result.cancelled).toBe(false);
  expect(result.tabs.map((t) => t.url)).toContain(url);
  expect(await other.evaluate(() => document.cookie)).toContain('project=two');
  await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({ artifactId: 'a', projectId: 'a', url }),
    url,
  );
  const reopened = await pageAt((p) => p.url() === url);
  await expect(reopened.getByRole('heading')).toBeVisible();
  expect(await reopened.evaluate(() => document.cookie)).not.toContain('project=one');
});

test('popup requires native input and shares the originating project', async () => {
  const first = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({ artifactId: 'a', projectId: 'a', url }),
    url,
  );
  const page = await pageAt((p) => p.url() === url);
  await expect(page.getByRole('heading')).toBeVisible();
  await page.evaluate(() => {
    document.cookie = 'popup=shared;path=/';
    window.open('/spontaneous');
  });
  expect((await app.evaluate(() => globalThis.browserTest.manager.snapshot())).tabs).toHaveLength(
    1,
  );
  await page.getByRole('button', { name: 'Open popup' }).click();
  const popup = await pageAt((p) => p.url() === url + 'popup');
  await expect(popup.getByRole('heading')).toBeVisible();
  expect(await popup.evaluate(() => document.cookie)).toContain('popup=shared');
  const state = await app.evaluate(() => globalThis.browserTest.manager.snapshot());
  expect(state.tabs.every((t) => t.artifactId === 'a' && t.projectId === 'a')).toBe(true);
  expect(state.activeTabId).not.toBe(first.id);
  await app.evaluate((_electron, id) => globalThis.browserTest.manager.select(id), first.id);
  await page
    .getByRole('link', { name: 'Background popup' })
    .click({ modifiers: ['ControlOrMeta'] });
  await pageAt((p) => p.url() === url + 'background-popup');
  expect((await app.evaluate(() => globalThis.browserTest.manager.snapshot())).activeTabId).toBe(
    first.id,
  );
});

test('download cancel does not create a file and Save As reports completion', async () => {
  await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({ artifactId: 'a', projectId: 'a', url }),
    url,
  );
  const page = await pageAt((p) => p.url() === url);
  await expect(page.getByRole('heading')).toBeVisible();
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialogSync = () => '';
  });
  await page.getByRole('link', { name: 'Download', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await app.evaluate(() => globalThis.browserTest.manager.snapshot())).downloads[0]?.status,
    )
    .toBe('cancelled');
  const path = join(root, 'saved.txt');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialogSync = () => path;
  }, path);
  await page.getByRole('link', { name: 'Download', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await app.evaluate(() => globalThis.browserTest.manager.snapshot())).downloads[1]?.status,
    )
    .toBe('completed');
  const { readFile } = await import('node:fs/promises');
  expect(await readFile(path, 'utf8')).toBe('Download fixture bytes');
});

test('profile clear cancellation retains storage and live tabs', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({ artifactId: 'a', projectId: 'a', url }),
    url,
  );
  const page = await pageAt((p) => p.url() === url);
  await page.getByRole('heading').click();
  await page.evaluate(() => {
    document.cookie = 'keep=yes;path=/';
    addEventListener('beforeunload', (event) => {
      event.preventDefault();
      event.returnValue = '';
    });
  });
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 1;
  });
  expect(
    (await app.evaluate(() => globalThis.browserTest.manager.clearProjectProfile('a'))).cancelled,
  ).toBe(true);
  expect(
    (await app.evaluate(() => globalThis.browserTest.manager.snapshot())).tabs.map((t) => t.id),
  ).toContain(tab.id);
  expect(await page.evaluate(() => document.cookie)).toContain('keep=yes');
});

test('capture deadline rejects a late frame before private draft or editor creation', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({ artifactId: 'a', projectId: 'a', url }),
    url,
  );
  const page = await pageAt((p) => p.url() === url);
  await expect(page.getByRole('heading')).toBeVisible();
  await app.evaluate(({ webContents }, url) => {
    process.env.PROJECTOR_CAPTURE_TIMEOUT_MS = '100';
    const contents = webContents.getAllWebContents().find((value) => value.getURL() === url)!;
    const original = contents.capturePage.bind(contents);
    contents.capturePage = async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return original();
    };
  }, url);
  await app.evaluate(
    async (_electron, id) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'annotate' }),
    tab.id,
  );
  const overlay = await pageAt(
    (p) =>
      p.url().startsWith('data:text/html;base64,') &&
      Buffer.from(p.url().split(',')[1], 'base64').toString().includes('id="layer"'),
  );
  await expect(overlay.getByRole('status')).toContainText('Click an element or drag an area');
  await overlay.mouse.click(60, 50);
  await expect(overlay.getByRole('status')).toContainText('Capture timed out');
  await page.waitForTimeout(500);
  expect(await app.evaluate(() => globalThis.browserTest.drafts.length)).toBe(0);
  expect((await app.evaluate(() => globalThis.browserTest.manager.snapshot())).annotating).toBe(
    false,
  );
  await expect(overlay.getByLabel('Area annotation comment')).toBeHidden();
});

declare global {
  var browserPermissionRequest: NonNullable<
    Parameters<Electron.Session['setPermissionRequestHandler']>[0]
  >;
  var browserPermissionCheck: NonNullable<
    Parameters<Electron.Session['setPermissionCheckHandler']>[0]
  >;
}

test('trusted permission decisions expire on origin change and reject background requests', async () => {
  const tab = await app.evaluate(
    async ({ session, dialog }, { url, partition }) => {
      const profile = session.fromPartition(partition);
      const request = profile.setPermissionRequestHandler.bind(profile);
      const check = profile.setPermissionCheckHandler.bind(profile);
      profile.setPermissionRequestHandler = (handler) => {
        if (handler) globalThis.browserPermissionRequest = handler;
        request(handler);
      };
      profile.setPermissionCheckHandler = (handler) => {
        if (handler) globalThis.browserPermissionCheck = handler;
        check(handler);
      };
      dialog.showMessageBox = async (
        first: Electron.BaseWindow | Electron.MessageBoxOptions,
        second?: Electron.MessageBoxOptions,
      ) => {
        globalThis.browserTest.drafts.push(second ?? first);
        return { response: 0, checkboxChecked: false };
      };
      return globalThis.browserTest.manager.open({
        artifactId: 'a',
        projectId: 'permissions',
        url,
      });
    },
    {
      url,
      partition:
        'persist:projector-browser-' + createHash('sha256').update('permissions').digest('hex'),
    },
  );
  const page = await pageAt((p) => p.url() === url);
  await expect(page.getByRole('heading')).toBeVisible();
  expect(
    await app.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((value) => value.getURL() === url)!;
      return new Promise<boolean>((resolve) =>
        globalThis.browserPermissionRequest(contents, 'media', resolve, {
          isMainFrame: true,
          requestingUrl: url,
          mediaTypes: ['audio', 'video'],
        }),
      );
    }, url),
  ).toBe(true);
  expect(
    await app.evaluate(({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((value) => value.getURL() === url)!;
      return globalThis.browserPermissionCheck(contents, 'media', new URL(url).origin, {
        isMainFrame: true,
        mediaType: 'video',
      });
    }, url),
  ).toBe(true);
  const prompts = await app.evaluate(() => globalThis.browserTest.drafts);
  expect(prompts).toEqual([
    expect.objectContaining({
      defaultId: 1,
      cancelId: 1,
      detail: expect.stringContaining('camera'),
    }),
  ]);
  await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({
        artifactId: 'b',
        projectId: 'permissions',
        url: url + 'background',
      }),
    url,
  );
  expect(
    await app.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((value) => value.getURL() === url)!;
      return new Promise<boolean>((resolve) =>
        globalThis.browserPermissionRequest(contents, 'geolocation', resolve, {
          isMainFrame: true,
          requestingUrl: url,
        }),
      );
    }, url),
  ).toBe(false);
  expect(await app.evaluate(() => globalThis.browserTest.drafts.length)).toBe(1);
  await pageAt((p) => p.url() === url + 'background');
  expect(
    await app.evaluate(({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((value) => value.getURL() === url + 'background')!;
      return globalThis.browserPermissionCheck(contents, 'media', new URL(url).origin, {
        isMainFrame: true,
        mediaType: 'video',
      });
    }, url),
  ).toBe(false);
  await app.evaluate(
    async (_electron, { id, url }) => {
      globalThis.browserTest.manager.select(id);
      await globalThis.browserTest.manager.command({
        tabId: id,
        action: 'navigate',
        url: url.replace('127.0.0.1', 'localhost'),
      });
    },
    { id: tab.id, url },
  );
  expect(
    await app.evaluate(({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((value) => value.getURL().includes('localhost'))!;
      return globalThis.browserPermissionCheck(contents, 'media', new URL(url).origin, {
        isMainFrame: true,
        mediaType: 'video',
      });
    }, url),
  ).toBe(false);
  await app.evaluate(
    async (_electron, { id, url }) =>
      globalThis.browserTest.manager.command({ tabId: id, action: 'navigate', url }),
    { id: tab.id, url },
  );
  expect(
    await app.evaluate(({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find((value) => value.getURL() === url)!;
      return globalThis.browserPermissionCheck(contents, 'media', new URL(url).origin, {
        isMainFrame: true,
        mediaType: 'video',
      });
    }, url),
  ).toBe(false);
});

test('Stop cancels a loading page and external opening uses its validated current URL', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({ artifactId: 'a', projectId: 'a', url: url + 'slow' }),
    url,
  );
  await expect
    .poll(
      async () =>
        (await app.evaluate(() => globalThis.browserTest.manager.snapshot())).tabs[0].loading,
    )
    .toBe(true);
  await app.evaluate(
    async (_electron, id) => globalThis.browserTest.manager.command({ tabId: id, action: 'stop' }),
    tab.id,
  );
  await expect
    .poll(
      async () =>
        (await app.evaluate(() => globalThis.browserTest.manager.snapshot())).tabs[0].loading,
    )
    .toBe(false);
  await app.evaluate(
    async ({ shell }, { id, url }) => {
      shell.openExternal = async (target) => {
        globalThis.browserTest.drafts.push({ external: target });
      };
      await globalThis.browserTest.manager.command({ tabId: id, action: 'navigate', url });
      await globalThis.browserTest.manager.command({ tabId: id, action: 'external' });
    },
    { id: tab.id, url },
  );
  expect(await app.evaluate(() => globalThis.browserTest.drafts)).toEqual([{ external: url }]);
});

test('live browser annotation supports focused keyboard element and region selection', async () => {
  const tab = await app.evaluate(
    async (_electron, url) =>
      globalThis.browserTest.manager.open({ artifactId: 'a', projectId: 'a', url }),
    url,
  );
  const page = await pageAt((p) => p.url() === url);
  await expect(page.getByRole('heading')).toBeVisible();
  await app.evaluate(async (_electron, id) => globalThis.browserTest.manager.beginArea(id), tab.id);
  const overlay = await pageAt(
    (p) =>
      p.url().startsWith('data:text/html;base64,') &&
      Buffer.from(p.url().split(',')[1], 'base64').toString().includes('id="layer"'),
  );
  const layer = overlay.getByRole('region', { name: 'Browser annotation selection' });
  await expect(layer).toBeFocused();
  // Showing a native overlay can synthesize a stationary pointer event under the
  // desktop cursor. It must not replace the keyboard's centered selection.
  await layer.dispatchEvent('pointermove', {
    clientX: 3,
    clientY: 423,
    movementX: 0,
    movementY: 0,
  });
  for (let index = 0; index < 4; index++) await layer.press('Shift+ArrowUp');
  await layer.dispatchEvent('pointermove', {
    clientX: 3,
    clientY: 423,
    movementX: 0,
    movementY: 0,
  });
  await expect(overlay.locator('#keyboard-pointer')).toHaveCSS('left', '420px');
  await expect(overlay.locator('#keyboard-pointer')).toHaveCSS('top', '70px');
  await layer.press('Enter');
  const composer = overlay.getByLabel('Area annotation comment');
  await expect(composer).toBeFocused();
  await composer.fill('Keyboard element');
  await composer.press('Enter');
  const element = await app.evaluate(() => globalThis.browserTest.annotations[0]);
  expect(element.capture.source.elementAnchor?.tag).toBe('H1');
  expect(element.capture.source.pointer).toEqual({ x: 420, y: 70 });
  await app.evaluate(async (_electron, id) => globalThis.browserTest.manager.beginArea(id), tab.id);
  await expect(layer).toBeFocused();
  await layer.press('Space');
  await layer.press('Shift+ArrowRight');
  await layer.press('Shift+ArrowDown');
  await layer.press('Enter');
  await expect(composer).toBeFocused();
  await composer.fill('Keyboard region');
  await composer.press('Enter');
  const region = await app.evaluate(() => globalThis.browserTest.annotations[1]);
  expect(region.capture.source.rect).toEqual({ x: 420, y: 270, width: 50, height: 50 });
  expect(region.capture.source.pointer).toEqual({ x: 470, y: 320 });
  expect(region.capture.source.elementAnchor).toBeUndefined();
});
