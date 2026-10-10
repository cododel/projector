import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  utilityProcess,
  clipboard,
  net,
  Menu,
  shell,
} from 'electron';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { readFile, mkdir, unlink } from 'node:fs/promises';
import type { RpcResponse } from '../shared/protocol';
import { getMcpSetup } from './mcp-setup';
import { BrowserManager } from './browser';
import { Workspace } from './workspace';
import { safeBrowserBounds, validateArea } from './browser-policy';
import { z } from 'zod';
const here = dirname(fileURLToPath(import.meta.url));
const developmentUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
app.setName('Blueprint');
if (process.env.BLUEPRINT_DATA) app.setPath('userData', process.env.BLUEPRINT_DATA);
const workspace = new Workspace(join(app.getPath('userData'), 'workspace.json'));
function workspaceRefresh() {
  window?.webContents.send('blueprint:refresh');
}
async function selectWorkspaceTab(artifactId: string, tabId: string) {
  const entry = workspace.find(artifactId, tabId);
  if (entry.kind === 'document') {
    await rpc('openArtifact', { artifactId, revisionId: entry.revisionId });
    browser?.select(null);
  } else if (entry.kind === 'browser' && browser) {
    if (entry.nativeId && browser.snapshot().tabs.some((t) => t.id === entry.nativeId))
      browser.select(entry.nativeId);
    else {
      const artifact = (await rpc('artifactProperties', { artifactId })) as { projectId: string };
      const native = await browser.open({
        artifactId,
        projectId: artifact.projectId,
        url: entry.url,
        newTab: true,
      });
      workspace.browser(artifactId, native, tabId);
    }
  } else browser?.select(null);
  workspace.select(artifactId, tabId);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'blueprint',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
const token = randomUUID();
let window: BrowserWindow | null = null;
let worker: Electron.UtilityProcess | null = null;
let connection: ReturnType<typeof connect> | null = null;
let quitting = false;
let browser: BrowserManager | null = null;
let browserDraftArtifact: string | null = null;
const requests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function failRpcRequests(): void {
  for (const pending of requests.values())
    pending.reject(
      new Error(
        'UNKNOWN_RESULT: Blueprint runtime disconnected. An operation may have completed; reconcile before retrying. Restart Blueprint and reconnect MCP.',
      ),
    );
  requests.clear();
}
function rpc(name: string, args: unknown = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!connection || connection.destroyed || connection.writableEnded) {
      reject(new Error('Blueprint runtime is unavailable'));
      return;
    }
    const id = randomUUID();
    requests.set(id, { resolve, reject });
    connection.write(
      JSON.stringify({ id, method: 'operator', params: { name, args }, token }) + '\n',
      (error) => {
        if (!error) return;
        failRpcRequests();
        connection?.destroy();
      },
    );
  });
}
async function showCapturedAnnotation(artifactId: string, annotationId: string) {
  if (!browser || !window) throw new Error('Browser surface unavailable');
  const value = (await rpc('getCapture', { artifactId, annotationId })) as {
    capture: { id: string; source: import('../runtime/artifact-state').Capture['source'] };
    png: string;
    number: number;
  };
  const bounds = await window.webContents.executeJavaScript(
    `(()=>{const el=document.querySelector('.browser-area')||document.querySelector('iframe')||document.querySelector('.new-tab-home');if(!el)throw Error('Capture surface unavailable');const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}})()`,
  );
  browser.setBounds(bounds);
  const { annotations } = (await rpc('getDocument', {
    artifactId,
    revisionId: ((await rpc('artifactProperties', { artifactId })) as { latestRevision: string })
      .latestRevision,
  })) as { annotations: { id: string; comment: string }[] };
  await browser.showCapture({
    artifactId,
    capture: { ...value.capture, png: value.png } as import('./browser').BrowserCapture,
    comment: annotations.find((x) => x.id === annotationId)?.comment ?? '',
    number: value.number,
  });
  return { shown: true };
}
function createWindow(background = false) {
  window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 650,
    title: 'Blueprint',
    show: !background,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  browser = new BrowserManager(window, {
    overlayPreload: join(here, '../preload/browser-overlay.cjs'),
    onChange: () => {
      if (browser && workspace.sync(browser.snapshot().tabs))
        void workspace.save().catch(console.error);
      workspaceRefresh();
    },
    getAnnotations: async (artifactId) => {
      const { draft } = (await rpc('snapshot')) as {
        draft?: { annotations: import('../runtime/store').Annotation[] };
      };
      return (draft?.annotations ?? [])
        .filter((a) => a.artifactId === artifactId && a.capture?.source.kind === 'browser-area')
        .map((a) => ({
          id: a.id,
          number: a.number ?? 1,
          comment: a.comment,
          capture: {
            source: {
              ...a.capture!.source,
              kind: 'browser-area' as const,
              url: a.capture!.source.url ?? '',
              title: a.capture!.source.title ?? '',
            },
          },
        }));
    },
    onMarkerSelect: ({ artifactId, annotationId }) =>
      showCapturedAnnotation(artifactId, annotationId),
    getRevision: async (artifactId) => {
      const snapshot = (await rpc('snapshot')) as {
        selected: { artifactId: string; revisionId: string | null } | null;
      };
      if (snapshot.selected?.artifactId === artifactId && snapshot.selected.revisionId)
        return snapshot.selected.revisionId;
      return (
        (await rpc('artifactProperties', { artifactId })) as { latestRevision: string | null }
      ).latestRevision;
    },
    onDraft: async (value) => {
      const artifactId = value?.artifactId ?? browserDraftArtifact;
      if (!artifactId) return;
      if (value) browserDraftArtifact = artifactId;
      await rpc('saveBrowserEditor', { artifactId, editor: value });
      await rpc('editing', { active: Boolean(value) });
      if (!value) browserDraftArtifact = null;
    },
    onAnnotation: async (value) => {
      const artifact = (await rpc('artifactProperties', { artifactId: value.artifactId })) as {
        latestRevision: string | null;
      };
      if (!artifact.latestRevision)
        throw new Error('Publish the document before annotating browser areas');
      const result = await rpc('addAreaAnnotation', {
        artifactId: value.artifactId,
        revisionId: value.revisionId ?? artifact.latestRevision,
        kind: 'browser-area',
        comment: value.comment,
        capture: value.capture,
      });
      return z.object({ id: z.string(), number: z.number().int().positive() }).parse(result);
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (
      !url.startsWith('blueprint://app/') &&
      !url.startsWith(developmentUrl ?? 'blueprint://app/')
    )
      event.preventDefault();
  });
  window.on('closed', () => {
    browser?.dispose();
    browser = null;
    window = null;
    if (!quitting) void rpc('editing', { active: false }).catch(() => {});
  });
  if (background) {
    const created = window;
    created.once('ready-to-show', () => {
      if (!created.isDestroyed()) created.showInactive();
    });
  }
  void window.loadURL('blueprint://app/index.html');
}
app.on('activate', () => {
  if (!window) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  worker?.postMessage('quit');
  const timer = setTimeout(() => {
    worker?.kill();
    app.quit();
  }, 4000);
  worker?.once('exit', () => {
    clearTimeout(timer);
    app.quit();
  });
  if (!worker) app.quit();
});
void app
  .whenReady()
  .then(async () => {
    await workspace.load();
    if (!app.requestSingleInstanceLock()) {
      quitting = true;
      app.quit();
      return;
    }
    app.on('second-instance', () => {
      if (!window) createWindow();
      window?.show();
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Blueprint',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'quit', label: 'Quit Blueprint' },
          ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    );
    const renderer = resolve(here, '../renderer');
    protocol.handle('blueprint', async (request) => {
      try {
        const url = new URL(request.url);
        if (!['app', 'document'].includes(url.hostname))
          return new Response('Not found', { status: 404 });
        if (developmentUrl) {
          const dev = await net.fetch(developmentUrl + url.pathname + url.search);
          return new Response(await dev.arrayBuffer(), {
            status: dev.status,
            headers: { 'Content-Type': dev.headers.get('Content-Type') ?? 'text/plain' },
          });
        }
        let path = decodeURIComponent(url.pathname);
        if (path === '/') path = '/index.html';
        const file = resolve(renderer, '.' + path);
        const rel = relative(renderer, file);
        if (rel.startsWith('..') || !rel) return new Response('Forbidden', { status: 403 });
        const body = await readFile(file);
        const ext = file.split('.').at(-1);
        const contentType =
          ext === 'html'
            ? 'text/html'
            : ext === 'js'
              ? 'text/javascript'
              : ext === 'css'
                ? 'text/css'
                : ext === 'svg'
                  ? 'image/svg+xml'
                  : 'application/octet-stream';
        return new Response(body, {
          headers: {
            'Content-Type': contentType,
            'Content-Security-Policy':
              "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src blueprint://document; base-uri 'none'; form-action 'none'",
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    const data = app.getPath('userData');
    await mkdir(join(data, 'runtime'), { recursive: true, mode: 0o700 });
    const socket = process.env.BLUEPRINT_SOCKET ?? join(data, 'runtime', 'service.sock');
    await new Promise<void>((resolve, reject) => {
      const probe = connect(socket);
      probe.once('connect', () => {
        probe.end();
        reject(new Error('A Blueprint runtime is already listening on this socket'));
      });
      probe.once('error', (error) => {
        if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? ''))
          resolve();
        else reject(error);
      });
    });
    await unlink(socket).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    worker = utilityProcess.fork(join(here, '../runtime/service.cjs'), [], {
      env: {
        ...process.env,
        BLUEPRINT_DATA: data,
        BLUEPRINT_SOCKET: socket,
        BLUEPRINT_OPERATOR_TOKEN: token,
        BLUEPRINT_COMPILER: join(here, '../runtime/compiler.cjs'),
      },
      stdio: 'pipe',
    });
    worker.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    await new Promise<void>((resolve, reject) => {
      worker!.once('exit', (code) => reject(new Error('Runtime exited: ' + code)));
      worker!.on('message', (message) => {
        if (message.type === 'ready') resolve();
        else if (message.type === 'refresh') {
          window?.webContents.send('blueprint:refresh');
          void browser
            ?.refreshAnnotations()
            .catch((error) => console.error('Browser annotation refresh failed', error));
        } else if (message.type === 'show-artifact') {
          if (!window) createWindow(true);
          workspace.document(message.artifactId, message.revisionId);
          void workspace.save().then(workspaceRefresh).catch(console.error);
          browser?.select(null);
        } else if (message.type === 'show-content') {
          if (!window) createWindow(true);
          void browser
            ?.open({
              artifactId: message.artifactId,
              projectId: message.projectId,
              url: message.url,
            })
            .then(async (native) => {
              if (native) {
                workspace.browser(message.artifactId, native);
                await workspace.save();
                workspaceRefresh();
              }
            })
            .catch((error) => console.error(error));
        }
      });
    });
    connection = connect(socket);
    // Errors may arrive after a write even though destroyed was false at dispatch.
    // Consume them for the entire socket lifetime, not only during connection setup.
    connection.on('error', () => {
      failRpcRequests();
      connection?.destroy();
    });
    connection.on('end', () => connection?.destroy());
    connection.on('close', failRpcRequests);
    await new Promise<void>((resolve, reject) => {
      connection!.once('connect', resolve);
      connection!.once('error', reject);
    });
    const responses = createInterface({ input: connection });
    responses.on('error', () => {
      failRpcRequests();
      connection?.destroy();
    });
    responses.on('line', (line) => {
      const response = JSON.parse(line) as RpcResponse;
      const pending = requests.get(response.id);
      if (!pending) return;
      requests.delete(response.id);
      if (response.error)
        pending.reject(new Error(response.error.code + ': ' + response.error.message));
      else pending.resolve(response.result);
    });
    ipcMain.handle('blueprint:invoke', async (event, name: string, args: unknown) => {
      const source = new URL(event.senderFrame?.url ?? 'about:blank');
      const trusted =
        (source.hostname === 'app' && source.protocol === 'blueprint:') ||
        (Boolean(developmentUrl) && event.senderFrame?.url.startsWith(developmentUrl!));
      if (!trusted || event.senderFrame !== event.sender.mainFrame)
        throw new Error('Untrusted IPC sender');
      if (name === 'workspaceSnapshot') return workspace.snapshot();
      if (name === 'workspaceLayout') {
        const layout = z
          .object({ leftSidebarVisible: z.boolean(), rightSidebarVisible: z.boolean() })
          .strict()
          .parse(args);
        const previous = workspace.snapshot();
        workspace.setLayout(layout);
        try {
          await workspace.save();
        } catch (error) {
          workspace.restore(previous);
          throw error;
        }
        workspaceRefresh();
        return workspace.snapshot();
      }
      if (name === 'workspaceCommand') {
        const input = z
          .object({
            artifactId: z.string(),
            action: z.enum(['new', 'select', 'close', 'open', 'address']),
            tabId: z.string().optional(),
            url: z.string().optional(),
          })
          .strict()
          .parse(args);
        const artifact = (await rpc('artifactProperties', { artifactId: input.artifactId })) as {
          projectId: string;
          latestRevision: string | null;
        };
        if (input.action !== 'address') await browser?.finishComment();
        const previous = workspace.snapshot();
        // Detect metadata write failures before destroying a site's live view.
        if (input.action === 'close') await workspace.save();
        if (input.action === 'new') {
          workspace.home(input.artifactId);
          browser?.select(null);
        } else {
          if (!input.tabId) throw new Error('WORKSPACE_TAB_REQUIRED');
          const entry = workspace.find(input.artifactId, input.tabId);
          if (input.action === 'address')
            workspace.address(input.artifactId, entry.id, z.string().parse(input.url));
          if (input.action === 'select') await selectWorkspaceTab(input.artifactId, entry.id);
          if (input.action === 'open') {
            if (!artifact.latestRevision)
              throw new Error('Publish the plan before opening browser content.');
            if (entry.kind !== 'home' || !browser) throw new Error('WORKSPACE_HOME_REQUIRED');
            const native = await browser.open({
              artifactId: input.artifactId,
              projectId: artifact.projectId,
              url: z.string().parse(input.url),
              newTab: true,
            });
            workspace.browser(input.artifactId, native, entry.id);
          }
          if (input.action === 'close') {
            if (
              entry.kind === 'browser' &&
              entry.nativeId &&
              browser?.snapshot().tabs.some((t) => t.id === entry.nativeId)
            ) {
              const result = await browser.command({ tabId: entry.nativeId, action: 'close' });
              if ('cancelled' in result && result.cancelled) return { cancelled: true };
            }
            workspace.close(input.artifactId, entry.id);
            const active = workspace.plan(input.artifactId).activeTabId;
            if (active) await selectWorkspaceTab(input.artifactId, active);
            else browser?.select(null);
          }
        }
        try {
          await workspace.save();
        } catch (error) {
          if (input.action === 'close') {
            workspace.restore(previous);
            workspaceRefresh();
          }
          throw error;
        }
        if (input.action !== 'address') workspaceRefresh();
        return workspace.snapshot();
      }
      if (name === 'openSession') {
        const artifactId = z.object({ artifactId: z.string() }).strict().parse(args).artifactId;
        const artifact = (await rpc('artifactProperties', { artifactId })) as {
          originSession: { harness: string; sessionId: string };
        };
        if (
          artifact.originSession.harness !== 'codex' ||
          !/^[a-zA-Z0-9-]+$/.test(artifact.originSession.sessionId)
        )
          throw new Error('INVALID_CODEX_SESSION');
        await shell.openExternal('codex://threads/' + artifact.originSession.sessionId);
        return { opened: true };
      }
      if (name === 'browserFinishComment') return browser?.finishComment();
      if (name === 'browserSnapshot')
        return browser?.snapshot() ?? { tabs: [], activeTabId: null, annotating: false };
      if (name.startsWith('browser') && browser) {
        const input = z.record(z.string(), z.unknown()).parse(args ?? {});
        if (name === 'browserOpen') {
          const artifactId = z.string().parse(input.artifactId);
          const url = z.string().parse(input.url);
          const artifact = (await rpc('artifactProperties', { artifactId })) as {
            id: string;
            projectId: string;
            latestRevision: string | null;
          };
          if (!artifact.latestRevision)
            throw new Error('Publish the document before opening browser content');
          const native = await browser.open({
            artifactId: artifact.id,
            projectId: artifact.projectId,
            url,
          });
          workspace.browser(artifact.id, native);
          await workspace.save();
          return native;
        }
        if (name === 'browserSelect') {
          browser.select(z.string().nullable().parse(input.tabId));
          return browser.snapshot();
        }
        if (name === 'browserBounds') {
          const rect = z
            .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
            .parse(input.bounds ?? input);
          browser.setBounds(rect);
          return { updated: true };
        }
        if (name === 'browserCommand') {
          const command = z
            .object({
              tabId: z.string(),
              action: z.enum(['back', 'forward', 'reload', 'navigate', 'close', 'annotate']),
              url: z.string().optional(),
            })
            .strict()
            .parse(input);
          return browser.command(command);
        }
        if (name === 'browserShowCapture') {
          return showCapturedAnnotation(
            z.string().parse(input.artifactId),
            z.string().parse(input.annotationId),
          );
        }
        if (name === 'browserRestoreDraft') {
          const artifactId = z.string().parse(input.artifactId);
          const draft = (await rpc('browserEditor', { artifactId })) as
            Parameters<BrowserManager['restoreDraft']>[0] | null;
          if (draft) {
            browserDraftArtifact = artifactId;
            const artifact = (await rpc('artifactProperties', { artifactId })) as {
              id: string;
              projectId: string;
            };
            const opened = await browser.open({
              artifactId,
              projectId: artifact.projectId,
              url: draft.capture.source.url,
            });
            const old = workspace
              .plan(artifactId)
              .tabs.find((t) => t.kind === 'browser' && t.url === draft.capture.source.url);
            workspace.browser(artifactId, opened, old?.id);
            await workspace.save();
            await browser.restoreDraft({ ...draft, tabId: opened.id });
            await rpc('editing', { active: true });
          }
          return { restored: Boolean(draft) };
        }
        throw new Error('Unsupported browser command');
      }
      if (name === 'captureDocumentArea') {
        if (!window) throw new Error('Document window unavailable');
        const input = z
          .object({
            artifactId: z.string(),
            revisionId: z.string(),
            rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
            pointer: z
              .object({
                x: z.number().finite().nonnegative(),
                y: z.number().finite().nonnegative(),
              })
              .strict(),
            viewport: z.object({ width: z.number(), height: z.number() }),
            scroll: z.object({ x: z.number(), y: z.number() }),
            zoom: z.number(),
          })
          .strict()
          .parse(args);
        await rpc('getDocument', { artifactId: input.artifactId, revisionId: input.revisionId });
        const current = (await rpc('snapshot')) as {
          selected: { artifactId: string; revisionId: string } | null;
        };
        if (
          current.selected?.artifactId !== input.artifactId ||
          current.selected.revisionId !== input.revisionId
        )
          throw new Error('Document selection changed');
        validateArea(input.rect, input.viewport);
        if (input.pointer.x > input.viewport.width || input.pointer.y > input.viewport.height)
          throw new Error('INVALID_POINTER: Pointer exceeds viewport');
        const frameBounds = await window.webContents.executeJavaScript(
          `(()=>{const f=document.querySelector('iframe');if(!f)throw Error('Document not visible');const b=f.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}})()`,
        );
        const bounds = safeBrowserBounds(frameBounds, {
          width: window.getContentSize()[0],
          height: window.getContentSize()[1],
        });
        if (
          Math.abs(bounds.width - input.viewport.width) > 2 ||
          Math.abs(bounds.height - input.viewport.height) > 2
        )
          throw new Error('CAPTURE_CHANGED: Document viewport changed');
        await window.webContents.executeJavaScript(
          'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
        );
        const image = await window.webContents.capturePage(bounds);
        return {
          id: randomUUID(),
          png: image.toPNG().toString('base64'),
          source: {
            kind: 'document-area',
            capturedAt: new Date().toISOString(),
            viewport: { ...input.viewport, deviceScaleFactor: input.zoom },
            rect: input.rect,
            pointer: input.pointer,
            zoomFactor: window.webContents.getZoomFactor(),
            scroll: input.scroll,
          },
        };
      }
      if (name === 'chooseProject') {
        const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
        if (result.canceled) return null;
        return rpc('register', { path: result.filePaths[0] });
      }
      if (name === 'setup') {
        return getMcpSetup({
          isPackaged: app.isPackaged,
          development: Boolean(developmentUrl),
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
          socketPath: socket,
          nodeOverride: process.env.BLUEPRINT_NODE,
        });
      }
      if (name === 'discard') {
        const answer = await dialog.showMessageBox(window!, {
          type: 'question',
          message: 'Discard private draft feedback?',
          detail:
            'Answers return to their latest submitted or compatible agreed values, or authored defaults. Submitted packages remain available.',
          buttons: ['Cancel', 'Discard draft'],
          defaultId: 0,
          cancelId: 0,
        });
        if (answer.response !== 1) return { discarded: false };
        return rpc('discard', args);
      }
      if (name === 'copyNotification') {
        const value = args as { text: unknown };
        if (typeof value.text !== 'string' || value.text.length > 10000)
          throw new Error('Invalid notification');
        await clipboard.writeText(value.text);
        return { copied: true };
      }
      const allowed = [
        'snapshot',
        'bindSession',
        'selectProject',
        'openArtifact',
        'getDocument',
        'setValue',
        'setViewState',
        'captureAnnotationState',
        'saveState',
        'getCapture',
        'addAreaAnnotation',
        'saveEditor',
        'addAnnotation',
        'editAnnotation',
        'deleteAnnotation',
        'submit',
        'approve',
        'editing',
        'demo',
      ];
      if (!allowed.includes(name)) throw new Error('Unsupported operator command');
      return rpc(name, args);
    });
    createWindow();
  })
  .catch((error) => {
    console.error(error);
    quitting = true;
    worker?.kill();
    app.quit();
  });
