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
import { runtimeLimits } from '../shared/runtime-limits';
import { getGuide } from '../guide';
import { atomicJson } from '../runtime/files';
import { getMcpSetup } from './mcp-setup';
import { BrowserManager } from './browser';
import { Workspace } from './workspace';
import { auditE2EWindows, e2eWindowOptions, isBackgroundE2E } from './e2e-window';
import { safeBrowserBounds, validateArea } from './browser-policy';
import { z } from 'zod';
const here = dirname(fileURLToPath(import.meta.url));
const developmentUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
auditE2EWindows(app);
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
const requests = new Map<
  string,
  {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function failRpcRequests(): void {
  for (const pending of requests.values()) {
    clearTimeout(pending.timer);
    pending.reject(
      new Error(
        'UNKNOWN_RESULT: Blueprint runtime disconnected. An operation may have completed; reconcile before retrying. Restart Blueprint and reconnect MCP.',
      ),
    );
  }
  requests.clear();
  window?.webContents.send('blueprint:operation-status', { waiting: false });
}
function rpc(name: string, args: unknown = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!connection || connection.destroyed || connection.writableEnded) {
      reject(new Error('Blueprint runtime is unavailable'));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      window?.webContents.send('blueprint:operation-status', { waiting: true, operation: name });
    }, 10000);
    requests.set(id, { resolve, reject, timer });
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
    revisionId: (
      (await rpc('artifactProperties', { artifactId })) as { latestRevision: string | null }
    ).latestRevision,
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
  window = new BrowserWindow(
    e2eWindowOptions({
      width: 1360,
      height: 900,
      minWidth: 980,
      minHeight: 650,
      title: 'Blueprint',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 13 },
      show: !background,
      webPreferences: {
        preload: join(here, '../preload/index.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    }),
  );
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
    onTabOpened: (tab, background) => {
      workspace.browser(tab.artifactId, tab, undefined, background);
      void workspace.save().then(workspaceRefresh).catch(console.error);
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
      const result = await rpc('addAreaAnnotation', {
        artifactId: value.artifactId,
        revisionId: value.revisionId ?? null,
        kind: 'browser-area',
        comment: value.comment,
        capture: value.capture,
      });
      return z.object({ id: z.string(), number: z.number().int().positive() }).parse(result);
    },
  });
  const recoverShell = async (reason: string) => {
    const target = window;
    if (!target || target.isDestroyed() || quitting || isBackgroundE2E()) return;
    const answer = await dialog.showMessageBox(target, {
      type: 'warning',
      message: 'Blueprint view stopped responding',
      detail: `${reason}. Reload restores confirmed local work. An interrupted Save must be reconciled before retrying.`,
      buttons: ['Cancel', 'Reload view'],
      defaultId: 0,
      cancelId: 0,
    });
    if (answer.response === 1 && !target.isDestroyed()) target.webContents.reload();
  };
  window.webContents.on('render-process-gone', (_event, details) => {
    void recoverShell(details.reason);
  });
  window.on('unresponsive', () => {
    void recoverShell('Renderer unresponsive');
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
  if (background && !isBackgroundE2E()) {
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
      if (!isBackgroundE2E()) window?.show();
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Blueprint',
          submenu: [
            { role: 'about' },
            { label: 'Closing a window keeps Blueprint runtime running', enabled: false },
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
      clearTimeout(pending.timer);
      requests.delete(response.id);
      window?.webContents.send('blueprint:operation-status', { waiting: false });
      if (response.error)
        pending.reject(
          Object.assign(new Error(response.error.code + ': ' + response.error.message), {
            code: response.error.code,
            details: response.error.details,
          }),
        );
      else pending.resolve(response.result);
    });
    ipcMain.handle('blueprint:invoke', async (event, name: string, args: unknown) => {
      const source = new URL(event.senderFrame?.url ?? 'about:blank');
      const trusted =
        (source.hostname === 'app' && source.protocol === 'blueprint:') ||
        (Boolean(developmentUrl) && event.senderFrame?.url.startsWith(developmentUrl!));
      if (!trusted || event.senderFrame !== event.sender.mainFrame)
        throw new Error('Untrusted IPC sender');
      if (name === 'projectMenu') {
        const { projectId } = z
          .object({ projectId: z.string().min(1) })
          .strict()
          .parse(args);
        const { projects } = (await rpc('snapshot')) as {
          projects: { id: string; available?: boolean }[];
        };
        const project = projects.find((item) => item.id === projectId);
        if (!project) throw new Error('PROJECT_NOT_FOUND');
        if (!window || window.isDestroyed()) throw new Error('Project window unavailable');
        const target = window;
        return new Promise<{ action: 'new' | 'locate' | 'remove' | null }>((resolve) => {
          const menu = Menu.buildFromTemplate([
            {
              label: 'New plan',
              enabled: project.available !== false,
              click: () => resolve({ action: 'new' }),
            },
            ...(project.available === false
              ? [{ label: 'Locate folder', click: () => resolve({ action: 'locate' }) }]
              : []),
            { type: 'separator' as const },
            { label: 'Remove from list', click: () => resolve({ action: 'remove' }) },
          ]);
          menu.popup({ window: target, callback: () => resolve({ action: null }) });
        });
      }
      if (name === 'planMenu') {
        const { artifactId } = z
          .object({ artifactId: z.string().min(1) })
          .strict()
          .parse(args);
        await rpc('artifactProperties', { artifactId });
        if (!window || window.isDestroyed()) throw new Error('Plan window unavailable');
        const target = window;
        return new Promise<{ action: 'rename' | null }>((resolve) => {
          const menu = Menu.buildFromTemplate([
            { label: 'Rename plan', click: () => resolve({ action: 'rename' }) },
          ]);
          menu.popup({ window: target, callback: () => resolve({ action: null }) });
        });
      }
      if (name === 'createEmptyPlan') {
        const input = z
          .object({ projectId: z.string().min(1), operationId: z.string().min(1) })
          .strict()
          .parse(args);
        await browser?.finishComment();
        const result = (await rpc('createEmptyPlan', input)) as {
          artifactId: string;
          sourcePath: string;
          sourceFile: string;
        };
        await rpc('selectProject', { projectId: input.projectId });
        await rpc('openArtifact', { artifactId: result.artifactId, revisionId: null });
        workspace.document(result.artifactId, null);
        browser?.select(null);
        await workspace.save();
        workspaceRefresh();
        return result;
      }
      if (name === 'renamePlan') {
        const input = z
          .object({
            artifactId: z.string().min(1),
            title: z.string().trim().min(1).max(300),
            operationId: z.string().min(1),
          })
          .strict()
          .parse(args);
        const result = await rpc('renamePlan', input);
        workspaceRefresh();
        return result;
      }
      if (name === 'workspaceSnapshot') return workspace.snapshot();
      if (name === 'workspaceLayout') {
        const layout = z
          .object({
            leftSidebarVisible: z.boolean(),
            rightSidebarVisible: z.boolean(),
            leftSidebarWidth: z.number().int().min(200).max(500).optional(),
            rightSidebarWidth: z.number().int().min(250).max(500).optional(),
          })
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
        // Selecting an already registered native page needs no document/manifest scan.
        // Lazy restoration and opening URLs still resolve the artifact from the runtime.
        const existing =
          input.action === 'select' && input.tabId
            ? workspace.find(input.artifactId, input.tabId)
            : null;
        const liveSelection =
          existing?.kind === 'browser' &&
          browser
            ?.snapshot()
            .tabs.some(
              (tab) => tab.id === existing.nativeId && tab.artifactId === input.artifactId,
            );
        const artifact = liveSelection
          ? null
          : ((await rpc('artifactProperties', { artifactId: input.artifactId })) as {
              projectId: string;
              latestRevision: string | null;
            });
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
            if (!artifact) throw new Error('WORKSPACE_ARTIFACT_REQUIRED');
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
          const native = await browser.open({
            artifactId: artifact.id,
            projectId: artifact.projectId,
            url,
          });
          workspace.browser(artifact.id, native);
          await workspace.save();
          return native;
        }
        if (name === 'browserClearProfile') {
          const projectId = z.string().parse(input.projectId);
          await browser.finishComment();
          const answer = await dialog.showMessageBox(window!, {
            type: 'warning',
            message: 'Clear browser data for this project?',
            detail:
              'Closes project pages and clears cookies, site storage and cache. You will be signed out. Plans, private work and annotation images remain.',
            buttons: ['Cancel', 'Clear profile'],
            defaultId: 0,
            cancelId: 0,
          });
          if (answer.response !== 1) return { cancelled: true };
          await workspace.save();
          const result = await browser.clearProjectProfile(projectId);
          // Native views can have closed before a later page cancels. URLs stay in workspace metadata.
          await workspace.save();
          workspaceRefresh();
          return result;
        }
        if (name === 'browserSelect') {
          browser.select(z.string().nullable().parse(input.tabId));
          return browser.snapshot();
        }
        if (name === 'browserResizeMode') {
          browser.setResizeMode(z.boolean().parse(input.active));
          return { updated: true };
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
              action: z.enum([
                'back',
                'forward',
                'reload',
                'stop',
                'zoom',
                'zoom-reset',
                'external',
                'navigate',
                'close',
                'annotate',
              ]),
              zoomFactor: z.number().min(0.5).max(2).optional(),
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
        let captureTimer: ReturnType<typeof setTimeout> | undefined;
        const image = await Promise.race([
          window.webContents.capturePage(bounds),
          new Promise<never>((_resolve, reject) => {
            captureTimer = setTimeout(
              () => reject(new Error('CAPTURE_TIMEOUT: Capture exceeded its time limit')),
              runtimeLimits().captureTimeoutMs,
            );
          }),
        ]).finally(() => clearTimeout(captureTimer));
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
      if (name === 'guide')
        return getGuide(
          z
            .object({ topic: z.string().optional(), reference: z.string().optional() })
            .strict()
            .parse(args ?? {}),
        );
      if (name === 'runtimeNotice') {
        try {
          return JSON.parse(
            await readFile(join(app.getPath('userData'), 'runtime-notice.json'), 'utf8'),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return { dismissed: false };
        }
      }
      if (name === 'dismissRuntimeNotice') {
        await atomicJson(join(app.getPath('userData'), 'runtime-notice.json'), { dismissed: true });
        return { dismissed: true };
      }
      if (name === 'chooseProject') {
        const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
        if (result.canceled) return null;
        const path = result.filePaths[0];
        try {
          return await rpc('register', { path });
        } catch (error) {
          const conflict = error as Error & {
            code?: string;
            details?: { projectId?: string; originalPath?: string };
          };
          if (conflict.code !== 'PROJECT_ID_CONFLICT' || !conflict.details?.projectId) throw error;
          const answer = await dialog.showMessageBox(window!, {
            type: 'question',
            message: 'This folder copies an existing Blueprint project',
            detail: `Registered original: ${conflict.details.originalPath}. A new empty project preserves copied history in a backup folder and imports no private work.`,
            buttons: ['Cancel', 'Open original', 'Create empty project'],
            defaultId: 0,
            cancelId: 0,
          });
          if (answer.response === 1) {
            await rpc('register', { path: conflict.details.originalPath });
            return rpc('selectProject', { projectId: conflict.details.projectId });
          }
          if (answer.response === 2)
            return rpc('registerCopy', { path, projectId: conflict.details.projectId });
          return null;
        }
      }
      if (name === 'locateProject') {
        const projectId = z.object({ projectId: z.string() }).parse(args).projectId;
        const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
        if (result.canceled) return null;
        return rpc('relocateProject', { projectId, path: result.filePaths[0] });
      }
      if (name === 'removeProject') {
        const projectId = z.object({ projectId: z.string() }).parse(args).projectId;
        const answer = await dialog.showMessageBox(window!, {
          type: 'question',
          message: 'Remove project from the list?',
          detail:
            'Project files and private work remain on disk. Choose the same folder again to restore it.',
          buttons: ['Cancel', 'Remove from list'],
          defaultId: 0,
          cancelId: 0,
        });
        if (answer.response !== 1) return { removed: false };
        const result = await rpc('removeProject', { projectId });
        const currentBrowser = browser?.snapshot();
        if (
          currentBrowser?.tabs.some(
            (tab) => tab.id === currentBrowser.activeTabId && tab.projectId === projectId,
          )
        )
          browser?.select(null);
        return result;
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
        'revokeApproval',
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
