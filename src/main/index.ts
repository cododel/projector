import { normalizeLegacyEnvironment, resolveApplicationData } from '../shared/brand-compat';
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
import { readFile, mkdir } from 'node:fs/promises';
import type { RpcResponse } from '../shared/protocol';
import { runtimeLimits } from '../shared/runtime-limits';
import { getGuide } from '../guide';
import { atomicJson } from '../runtime/files';
import { getMcpSetup } from './mcp-setup';
import { BrowserManager, type BrowserTab } from './browser';
import { Workspace } from './workspace';
import { ApplicationWorkspace, applicationSettingsSchema } from './application-workspace';
import { TerminalManager } from './terminals';
import { HarnessSync } from './harness-sync';
import { TerminalOutputDelivery } from './terminal-delivery';
import { CodexManager } from './codex';
import { paneLeaves } from '../shared/application-workspace';
import { matchShortcut } from '../shared/keyboard-shortcuts';
import type { McpSetup } from '../shared/protocol';
import { auditE2EWindows, e2eWindowOptions, isBackgroundE2E } from './e2e-window';
import { safeBrowserBounds, validateArea } from './browser-policy';
import { z } from 'zod';
const here = dirname(fileURLToPath(import.meta.url));
const developmentUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
normalizeLegacyEnvironment();
auditE2EWindows(app);
app.setName('Projector');
const applicationData = resolveApplicationData(app.getPath('appData'));
app.setPath('userData', applicationData);
app.setPath('sessionData', applicationData);
const workspace = new Workspace(join(app.getPath('userData'), 'workspace.json'));
const applicationWorkspace = new ApplicationWorkspace(join(app.getPath('userData'), 'application-workspace.json'));
let mcpSetup: McpSetup | null = null;
const runningTerminals = new Set<string>();
const knownTerminals = new Set<string>();
const terminalDelivery = new TerminalOutputDelivery(delivery => window?.webContents.send('projector:terminal-output', delivery));
ipcMain.on('projector:terminal-output-ack', (event, deliveryId: unknown) => {
  if (window && event.sender === window.webContents && event.senderFrame === event.sender.mainFrame && typeof deliveryId === 'string')
    terminalDelivery.acknowledge(deliveryId);
});
const terminals = new TerminalManager({
  onChange: (records) => {
    const live = new Set(records.filter(record => record.status === 'running').map(record => record.id));
    const currentIds = new Set(records.map(record => record.id));
    const removed = [...knownTerminals].filter(id => !currentIds.has(id));
    knownTerminals.clear();
    for (const id of currentIds) knownTerminals.add(id);
    const ended = [...runningTerminals].filter(id => !live.has(id));
    runningTerminals.clear();
    for (const id of live) runningTerminals.add(id);
    for (const id of ended) void codex.terminalStopped(id).catch(() => {});
    if (removed.length && !quitting) void applicationMutation(async () => {
      const current = await terminals.snapshot();
      applicationWorkspace.retainTerminals(new Set(current.map(record => record.id)));
    }).catch(error => console.error('Ended terminal views could not be removed', error));
    workspaceRefresh();
  },
  onOutput: (output) => {
    if (window && !window.isDestroyed()) terminalDelivery.offer(output);
  },
});
const codex = new CodexManager({
  getExecutable: () => {
    const path = applicationWorkspace.snapshot().settings.codexExecutable;
    return path === 'codex' ? process.env.PROJECTOR_E2E_CODEX_EXECUTABLE ?? path : path;
  },
  getProfile: () => applicationWorkspace.snapshot().settings.codexProfile || undefined,
  getMcpOverrides: () => {
    if (!mcpSetup) throw new Error('MCP setup is unavailable');
    return {
      'mcp_servers.projector.command': mcpSetup.executable,
      'mcp_servers.projector.args': mcpSetup.args,
      'mcp_servers.projector.env.PROJECTOR_RUNTIME_DESCRIPTOR': mcpSetup.descriptorPath,
    };
  },
  onIdentity: (terminalId, sessionId) => {
    void applicationMutation(async () => {
      await terminals.bindSession(terminalId, sessionId);
      const record = (await terminals.snapshot()).find(item => item.id === terminalId);
      if (!record) return;
      const previousSurface = applicationWorkspace.snapshot().selectedSurface;
      const selected = applicationWorkspace.snapshot().selectedWorkspace;
      const old = selected ? applicationWorkspace.workspace(selected) : null;
      const wasFocused = old?.tabs.flatMap(tab => paneLeaves(tab.root)).some(pane =>
        pane.id === old.activePaneId && (pane.content.kind === 'terminal' || pane.content.kind === 'session') && pane.content.terminalId === terminalId);
      const key = applicationWorkspace.select(record.projectId, sessionId);
      applicationWorkspace.bindSessionTerminal(key, terminalId);
      if ((!wasFocused || previousSurface === 'project') && selected) applicationWorkspace.restore({ ...applicationWorkspace.snapshot(), selectedWorkspace: selected, selectedSurface: previousSurface });
    }).catch(error => console.error('Session workspace could not be saved', error));
  },
  onChange: workspaceRefresh,
  onError: workspaceRefresh,
});
const harnessInterval = Number(process.env.PROJECTOR_E2E_HARNESS_INTERVAL_MS);
const harnessSync = new HarnessSync(async () => {
  const state = await rpc('snapshot') as { projects: { id: string; path: string }[] };
  await codex.discover(state.projects);
}, Number.isFinite(harnessInterval) && harnessInterval >= 100 ? harnessInterval : 15000);
let harnessChanges: Promise<unknown> = Promise.resolve();
function harnessMutation<T>(action: () => Promise<T>): Promise<T> {
  const operation = harnessChanges.catch(() => {}).then(async () => {
    if (quitting) throw new Error('Projector is shutting down.');
    harnessSync.stop(); await harnessSync.settled();
    try { return await action(); }
    finally { if (!quitting) harnessSync.start(); }
  });
  harnessChanges = operation;
  return operation;
}
let applicationWrites: Promise<unknown> = Promise.resolve();
let shortcutCapture = false;
const editingScopes = new Set<string>();
function setEditingScope(scope: string, active: boolean) {
  if (active) editingScopes.add(scope);
  else editingScopes.delete(scope);
  return rpc('editing', { active: editingScopes.size > 0 });
}
function clearRendererEditingScopes() {
  for (const scope of editingScopes) if (scope !== 'browser') editingScopes.delete(scope);
  return rpc('editing', { active: editingScopes.size > 0 });
}
function applicationMutation<T>(action: () => Promise<T> | T): Promise<T> {
  if (quitting) return Promise.reject(new Error('Projector is shutting down.'));
  const write = applicationWrites.catch(() => {}).then(async () => {
    applicationWorkspace.assertConfirmed();
    workspace.assertConfirmed();
    const previous = applicationWorkspace.snapshot();
    try {
      const result = await action();
      await applicationWorkspace.save();
      workspaceRefresh();
      return result;
    } catch (error) {
      if (!applicationWorkspace.hasPendingConfirmation() && !workspace.hasPendingConfirmation())
        applicationWorkspace.restore(previous);
      workspaceRefresh();
      throw error;
    }
  });
  applicationWrites = write;
  return write;
}
async function activateApplicationPane(key: string, paneId: string) {
  const content = applicationWorkspace.findPane(key, paneId).content;
  applicationWorkspace.focus(key, paneId);
  await rpc('selectProject', { projectId: applicationWorkspace.workspace(key).projectId });
  if (content.kind === 'terminal' || content.kind === 'session') { browser?.select(null); return; }
  const document = content.tab.kind === 'document' ? content : applicationWorkspace.workspace(key).tabs
    .flatMap(tab => paneLeaves(tab.root)).map(pane => pane.content)
    .find(pane => pane.kind === 'plan' && pane.artifactId === content.artifactId && pane.tab.kind === 'document');
  const revisionId = document?.kind === 'plan' && document.tab.kind === 'document' ? document.tab.revisionId :
    ((await rpc('artifactProperties', { artifactId: content.artifactId })) as { latestRevision: string | null }).latestRevision;
  // Workspace selection already owns navigation. Emitting show-artifact here would
  // enqueue an older operator selection after a concurrent public publication.
  await rpc('openArtifact', { artifactId: content.artifactId, revisionId, workspace: true });
  if (content.tab.kind === 'document') {
    browser?.select(null);
  } else if (content.tab.kind === 'browser' && browser) {
    const nativeId = content.tab.nativeId;
    const existing = nativeId && browser.snapshot().tabs.find(tab => tab.id === nativeId);
    if (existing) browser.select(existing.id);
    else {
      const native = await ensureApplicationBrowser(key, paneId);
      browser.select(native.id);
    }
  } else browser?.select(null);
}
const browserPaneOpenings = new Map<string, { owner: BrowserManager; promise: Promise<BrowserTab> }>();
function ensureApplicationBrowser(key: string, paneId: string): Promise<BrowserTab> {
  const owner = browser;
  if (!owner) return Promise.reject(new Error('Browser surface unavailable'));
  const current = applicationWorkspace.workspace(key);
  const content = applicationWorkspace.findPane(key, paneId).content;
  if (content.kind !== 'plan' || content.tab.kind !== 'browser')
    return Promise.reject(new Error('BROWSER_PANE_REQUIRED'));
  const tab = content.tab;
  const live = owner.snapshot().tabs.find(native => native.id === tab.nativeId && native.artifactId === content.artifactId);
  if (live) return Promise.resolve(live);
  const identity = `${key}/${paneId}`;
  const pending = browserPaneOpenings.get(identity);
  if (pending?.owner === owner) return pending.promise;
  // Lazy pane rendering and private composer recovery can arrive concurrently.
  // Both must bind the same page, independently of equal URLs in other workspaces.
  const promise = Promise.resolve().then(async () => {
    const native = await owner.open({ artifactId: content.artifactId, projectId: current.projectId,
      url: tab.url, newTab: true, background: true });
    if (browser !== owner) throw new Error('Browser surface changed during restoration');
    const latest = applicationWorkspace.findPane(key, paneId).content;
    if (latest.kind !== 'plan' || latest.artifactId !== content.artifactId || latest.tab.kind !== 'browser' || latest.tab.id !== tab.id)
      throw new Error('BROWSER_PANE_CHANGED');
    latest.tab.nativeId = native.id;
    return native;
  });
  browserPaneOpenings.set(identity, { owner, promise });
  void promise.finally(() => {
    if (browserPaneOpenings.get(identity)?.promise === promise) browserPaneOpenings.delete(identity);
  }).catch(() => {});
  return promise;
}
async function applicationPlan(artifactId: string, revisionId: string | null, alreadySelected = false) {
  const artifact = await rpc('artifactProperties', { artifactId }) as { projectId: string };
  const selected = applicationWorkspace.snapshot().selectedWorkspace;
  const current = selected ? applicationWorkspace.workspace(selected) : null;
  const key = current?.projectId === artifact.projectId ? selected! : applicationWorkspace.select(artifact.projectId, null);
  const tab = workspace.document(artifactId, revisionId);
  const pane = applicationWorkspace.openPlan(key, artifactId, tab);
  if (alreadySelected) browser?.select(null);
  else await activateApplicationPane(key, pane.id);
  await workspace.save();
  return pane;
}
function workspaceRefresh() {
  window?.webContents.send('projector:refresh');
}
function applicationShortcut(input: Electron.Input): boolean {
  if (shortcutCapture || input.type !== 'keyDown') return false;
  const action = matchShortcut({ key: input.key, metaKey: input.meta, ctrlKey: input.control,
    altKey: input.alt, shiftKey: input.shift, isComposing: input.isComposing, repeat: input.isAutoRepeat },
    applicationWorkspace.snapshot().settings.shortcuts, process.platform);
  if (!action) return false;
  window?.webContents.send('projector:shortcut', action);
  return true;
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
    scheme: 'projector',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
let window: BrowserWindow | null = null;
let worker: Electron.UtilityProcess | null = null;
let runtimeReady = false;
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
        'UNKNOWN_RESULT: Projector runtime disconnected. An operation may have completed; reconcile before retrying. Restart Projector and reconnect MCP.',
      ),
    );
  }
  requests.clear();
  window?.webContents.send('projector:operation-status', { waiting: false });
}
function rpc(name: string, args: unknown = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!worker || !runtimeReady) {
      reject(new Error('Projector runtime is unavailable'));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      window?.webContents.send('projector:operation-status', { waiting: true, operation: name });
    }, 10000);
    requests.set(id, { resolve, reject, timer });
    try {
      worker.postMessage({ type: 'operator', id, name, args });
    } catch {
      failRpcRequests();
    }
  });
}
async function showCapturedAnnotation(artifactId: string, annotationId: string, requestedPaneId?: string) {
  if (!browser || !window) throw new Error('Browser surface unavailable');
  const value = (await rpc('getCapture', { artifactId, annotationId })) as {
    capture: { id: string; source: import('../runtime/artifact-state').Capture['source'] };
    png: string;
    number: number;
  };
  const key = applicationWorkspace.snapshot().selectedWorkspace;
  let paneId: string | undefined;
  if (key) {
    const entry = applicationWorkspace.workspace(key);
    const tab = entry.tabs.find(tab => tab.id === entry.activeTabId);
    const panes = tab ? paneLeaves(tab.root) : [];
    const pane = requestedPaneId ? panes.find(pane => pane.id === requestedPaneId) :
      panes.find(pane => pane.id === entry.activePaneId && pane.content.kind === 'plan' && pane.content.artifactId === artifactId);
    if (!pane || pane.content.kind !== 'plan' || pane.content.artifactId !== artifactId)
      throw new Error('CAPTURE_PANE_MISMATCH');
    paneId = pane.id;
    if (pane.content.tab.kind !== 'browser') browser.select(null);
  }
  const bounds = await window.webContents.executeJavaScript(
    `(()=>{const id=${JSON.stringify(paneId ?? null)};const el=id?[...document.querySelectorAll('[data-pane-id],[data-browser-pane]')].find(el=>el.dataset.paneId===id||el.dataset.browserPane===id):document.querySelector('.browser-area')||document.querySelector('iframe')||document.querySelector('.new-tab-home');if(!el)throw Error('Capture surface unavailable');const b=el.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}})()`,
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
      title: 'Projector',
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
    onShortcut: applicationShortcut,
    hasUnfinishedEditor: () => [...editingScopes].some(scope => scope !== 'browser'),
    onViewFocus: ({ viewId }) => {
      const key = applicationWorkspace.snapshot().selectedWorkspace;
      if (!key || applicationWorkspace.snapshot().selectedSurface === 'project' || applicationWorkspace.workspace(key).activePaneId === viewId) return;
      // Native pages cannot run the shell's document-editor drain themselves.
      // Route their focus request through the same acknowledged transition as tabs.
      window?.webContents.send('projector:focus-pane', { key, paneId: viewId });
    },
    overlayPreload: join(here, '../preload/browser-overlay.cjs'),
    onChange: () => {
      if (browser && !workspace.hasPendingConfirmation() && workspace.sync(browser.snapshot().tabs))
        void workspace.save().catch(console.error);
      if (browser && !applicationWorkspace.hasPendingConfirmation() && applicationWorkspace.syncBrowser(browser.snapshot().tabs))
        void applicationWorkspace.save().catch(console.error);
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
      const entry = workspace.browser(tab.artifactId, tab, undefined, background);
      void applicationMutation(async () => {
        const previous = applicationWorkspace.snapshot();
        const selected = previous.selectedWorkspace;
        const current = selected ? applicationWorkspace.workspace(selected) : null;
        const key = current?.projectId === tab.projectId ? selected! : applicationWorkspace.select(tab.projectId, null);
        applicationWorkspace.openPlan(key, tab.artifactId, entry);
        if (background && current) {
          const restored = applicationWorkspace.snapshot();
          restored.selectedWorkspace = previous.selectedWorkspace;
          restored.selectedSurface = previous.selectedSurface;
          const before = previous.workspaces[key];
          if (before) { restored.workspaces[key].activeTabId = before.activeTabId; restored.workspaces[key].activePaneId = before.activePaneId; }
          applicationWorkspace.restore(restored);
        }
        await workspace.save();
      }).catch(console.error);
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
      if (value) await setEditingScope('browser', true);
      await rpc('saveBrowserEditor', { artifactId, editor: value });
      if (!value) await setEditingScope('browser', false);
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
  }, app.getPath('sessionData'));
  window.webContents.on('before-input-event', (event, input) => {
    if (applicationShortcut(input)) event.preventDefault();
  });
  const recoverShell = async (reason: string) => {
    const target = window;
    if (!target || target.isDestroyed() || quitting || isBackgroundE2E()) return;
    const answer = await dialog.showMessageBox(target, {
      type: 'warning',
      message: 'Projector view stopped responding',
      detail: `${reason}. Reload restores confirmed local work. An interrupted Save must be reconciled before retrying.`,
      buttons: ['Cancel', 'Reload view'],
      defaultId: 0,
      cancelId: 0,
    });
    if (answer.response === 1 && !target.isDestroyed()) target.webContents.reload();
  };
  window.webContents.on('render-process-gone', (_event, details) => {
    terminalDelivery.clear();
    void clearRendererEditingScopes().catch(console.error);
    void recoverShell(details.reason);
  });
  window.on('unresponsive', () => {
    void recoverShell('Renderer unresponsive');
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) terminalDelivery.clear();
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (
      !url.startsWith('projector://app/') &&
      !url.startsWith(developmentUrl ?? 'projector://app/')
    )
      event.preventDefault();
  });
  window.on('closed', () => {
    terminalDelivery.clear();
    shortcutCapture = false;
    browser?.dispose();
    browser = null;
    window = null;
    editingScopes.clear();
    if (!quitting) void rpc('editing', { active: false }).catch(() => {});
  });
  if (background && !isBackgroundE2E()) {
    const created = window;
    created.once('ready-to-show', () => {
      if (!created.isDestroyed()) created.showInactive();
    });
  }
  void window.loadURL('projector://app/index.html');
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
  void quitAfterCleanup();
});
async function quitAfterCleanup() {
  harnessSync.stop();
  // Process ownership is independent of the artifact runtime. A live but
  // unresponsive runtime must not hold PTY cleanup behind an unanswered RPC.
  const ownedCleanup = Promise.allSettled([terminals.shutdown(), codex.stop()]);
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    applicationWrites.then(() => true, error => {
      console.error('Workspace write failed during Quit', error);
      return true;
    }),
    new Promise<false>(resolve => {
      drainTimer = setTimeout(() => resolve(false), 10000);
    }),
  ]);
  clearTimeout(drainTimer);
  if (!drained) {
    console.error('UNKNOWN_RESULT: Workspace write did not settle during Quit. Reconcile its persisted result after restart; it was not cancelled or replayed.');
    failRpcRequests();
  }
  const cleanup = await ownedCleanup;
  for (const result of cleanup) if (result.status === 'rejected') console.error('Process cleanup failed during Quit', result.reason);
  // Runtime exit, including its force deadline, must never interrupt owned PTY
  // cleanup. Terminal shutdown has its own verified process-tree fallback.
  const runtime = worker;
  if (runtime?.pid) await new Promise<void>(resolve => {
    const finished = () => { clearTimeout(timer); resolve(); };
    runtime.once('exit', finished);
    const timer = setTimeout(() => {
      runtime.removeListener('exit', finished);
      runtime.kill();
      resolve();
    }, 10000);
    try { runtime.postMessage('quit'); }
    catch { runtime.removeListener('exit', finished); finished(); }
  });
  app.quit();
}
void app
  .whenReady()
  .then(async () => {
    await workspace.load();
    await applicationWorkspace.load();
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
          label: 'Projector',
          submenu: [
            { role: 'about' },
            { label: 'Settings…', click: () => window?.webContents.send('projector:open-settings') },
            { label: 'Closing a window keeps Projector runtime running', enabled: false },
            { type: 'separator' },
            { role: 'quit', label: 'Quit Projector' },
          ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    );
    const renderer = resolve(here, '../renderer');
    protocol.handle('projector', async (request) => {
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
              "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src projector://document; base-uri 'none'; form-action 'none'",
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    const data = app.getPath('userData');
    await mkdir(join(data, 'runtime'), { recursive: true, mode: 0o700 });
    if (process.env.PROJECTOR_SOCKET)
      throw new Error('PROJECTOR_SOCKET is no longer supported. Use PROJECTOR_RUNTIME_DESCRIPTOR.');
    const descriptorPath =
      process.env.PROJECTOR_RUNTIME_DESCRIPTOR ?? join(data, 'runtime', 'endpoint.json');
    worker = utilityProcess.fork(join(here, '../runtime/service.cjs'), [], {
      env: {
        ...process.env,
        PROJECTOR_DATA: data,
        PROJECTOR_RUNTIME_DESCRIPTOR: descriptorPath,
        PROJECTOR_COMPILER: join(here, '../runtime/compiler.cjs'),
      },
      stdio: 'pipe',
    });
    worker.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    await new Promise<void>((resolve, reject) => {
      worker!.once('exit', (code) => reject(new Error('Runtime exited: ' + code)));
      worker!.on('message', (message) => {
        if (message.type === 'ready') {
          runtimeReady = true;
          resolve();
        } else if (message.type === 'operator-response') {
          const response = message as RpcResponse;
          const pending = requests.get(response.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          requests.delete(response.id);
          window?.webContents.send('projector:operation-status', { waiting: false });
          if (response.error)
            pending.reject(
              Object.assign(new Error(response.error.code + ': ' + response.error.message), {
                code: response.error.code,
                details: response.error.details,
              }),
            );
          else pending.resolve(response.result);
        }
        else if (message.type === 'refresh') {
          window?.webContents.send('projector:refresh');
          void browser
            ?.refreshAnnotations()
            .catch((error) => console.error('Browser annotation refresh failed', error));
        } else if (message.type === 'show-artifact') {
          if (!window) createWindow(true);
          // The runtime has already applied this selection. Do not replay the operator mutation.
          void applicationMutation(() => applicationPlan(message.artifactId, message.revisionId, true)).catch(console.error);
        } else if (message.type === 'show-content') {
          if (!window) createWindow(true);
          void applicationMutation(async () => {
            if (!browser) throw new Error('Browser window unavailable');
            const selected = applicationWorkspace.snapshot().selectedWorkspace;
            const current = selected ? applicationWorkspace.workspace(selected) : null;
            const key = current?.projectId === message.projectId ? selected! : applicationWorkspace.select(message.projectId, null);
            const natives = browser.snapshot().tabs;
            // A session owns its native page. Reusing another workspace's URL
            // would make closing this view destroy that session's form state.
            const existing = applicationWorkspace.workspace(key).tabs
              .flatMap(tab => paneLeaves(tab.root))
              .find(pane => pane.content.kind === 'plan' && pane.content.artifactId === message.artifactId &&
                pane.content.tab.kind === 'browser' && pane.content.tab.url === message.url);
            const content = existing?.content.kind === 'plan' && existing.content.tab.kind === 'browser' ? existing.content : null;
            const existingNativeId = content?.tab.kind === 'browser' ? content.tab.nativeId : undefined;
            const live = natives.find(tab => tab.id === existingNativeId && tab.artifactId === message.artifactId);
            const native = live ?? await browser.open({
              artifactId: message.artifactId, projectId: message.projectId,
              url: message.url, newTab: true,
            });
            if (live) browser.select(live.id);
            const tab = workspace.browser(message.artifactId, native);
            if (existing && content) {
              applicationWorkspace.planTab(key, existing.id, { ...tab, id: content.tab.id });
              applicationWorkspace.focus(key, existing.id);
            } else applicationWorkspace.openPlan(key, message.artifactId, tab);
            await workspace.save();
          })
            .catch((error) => console.error(error));
        }
      });
    });
    worker.once('exit', () => {
      runtimeReady = false;
      failRpcRequests();
    });
    mcpSetup = await getMcpSetup({ isPackaged: app.isPackaged, development: Boolean(developmentUrl),
      appPath: app.getAppPath(), resourcesPath: process.resourcesPath, descriptorPath,
      nodeOverride: process.env.PROJECTOR_NODE });
    await terminals.start(data, join(here, '../terminal/service.cjs'), {
      scrollback: applicationWorkspace.snapshot().settings.terminalScrollback,
    });
    applicationWorkspace.retainTerminals(new Set((await terminals.snapshot()).map(record => record.id)));
    for (const terminal of await terminals.snapshot()) {
      if (terminal.kind !== 'codex' || !terminal.harnessSessionId) continue;
      const key = `${terminal.projectId}/${terminal.harnessSessionId}`;
      if (applicationWorkspace.snapshot().workspaces[key]) {
        const previous = applicationWorkspace.snapshot();
        applicationWorkspace.bindSessionTerminal(key, terminal.id);
        const next = applicationWorkspace.snapshot();
        next.selectedWorkspace = previous.selectedWorkspace;
        next.selectedSurface = previous.selectedSurface;
        if (next.workspaces[key].tabs.some(tab => tab.id === previous.workspaces[key].activeTabId)) next.workspaces[key].activeTabId = previous.workspaces[key].activeTabId;
        if (next.workspaces[key].tabs.some(tab => paneLeaves(tab.root).some(pane => pane.id === previous.workspaces[key].activePaneId))) next.workspaces[key].activePaneId = previous.workspaces[key].activePaneId;
        applicationWorkspace.restore(next);
      }
    }

    const restored = await rpc('snapshot') as { artifacts: { id: string; projectId: string }[]; projects: { id: string }[];
      selected: { artifactId: string; revisionId: string | null } | null };
    const restoredWorkspace = applicationWorkspace.snapshot();
    if (restoredWorkspace.selectedWorkspace && !restored.projects.some(project =>
      project.id === restoredWorkspace.workspaces[restoredWorkspace.selectedWorkspace!]?.projectId))
      applicationWorkspace.restore({ ...restoredWorkspace, selectedWorkspace: null });
    applicationWorkspace.migrateLegacy(workspace.snapshot(), restored.artifacts);
    if (!applicationWorkspace.snapshot().selectedWorkspace && restored.selected && applicationWorkspace.snapshot().settings.restoreWorkspace) {
      const artifact = restored.artifacts.find(item => item.id === restored.selected!.artifactId);
      if (artifact) applicationWorkspace.select(artifact.projectId, null);
    }
    await applicationWorkspace.save();
    ipcMain.handle('projector:invoke', async (event, name: string, args: unknown) => {
      const source = new URL(event.senderFrame?.url ?? 'about:blank');
      const trusted =
        (source.hostname === 'app' && source.protocol === 'projector:') ||
        (Boolean(developmentUrl) && event.senderFrame?.url.startsWith(developmentUrl!));
      if (!trusted || event.senderFrame !== event.sender.mainFrame)
        throw new Error('Untrusted IPC sender');
      if (quitting) throw new Error('Projector is shutting down.');
      if (name === 'shortcutCapture') {
        const { active } = z.object({ active: z.boolean() }).strict().parse(args);
        shortcutCapture = active;
        event.sender.setIgnoreMenuShortcuts(active);
        return { updated: true };
      }
      if (name === 'applicationSnapshot')
        return { ...applicationWorkspace.snapshot(), terminals: await terminals.snapshot(), harnesses: codex.snapshot(),
          metadataPending: applicationWorkspace.hasPendingConfirmation() || workspace.hasPendingConfirmation() };
      if (name === 'applicationConfirmation')
        return { pending: applicationWorkspace.hasPendingConfirmation() || workspace.hasPendingConfirmation() };
      if (name === 'confirmWorkspaceWrite') {
        await applicationWrites.catch(() => {});
        await workspace.confirmPending();
        await applicationWorkspace.confirmPending();
        if (browser) {
          const tabs = browser.snapshot().tabs;
          if (workspace.sync(tabs)) await workspace.save();
          if (applicationWorkspace.syncBrowser(tabs)) await applicationWorkspace.save();
        }
        await workspace.save();
        await applicationWorkspace.save();
        workspaceRefresh();
        return { confirmed: true };
      }
      if (name === 'harnessPin') {
        const value = z.object({ sessionId: z.string().min(1), pinned: z.boolean() }).strict().parse(args);
        if (!codex.snapshot().sessions.some(session => session.id === value.sessionId)) throw new Error('CODEX_SESSION_NOT_FOUND');
        return applicationMutation(() => { applicationWorkspace.pinSession(value.sessionId, value.pinned); return { pinned: value.pinned }; });
      }
      if (name === 'harnessArchive') {
        const value = z.object({ sessionId: z.string().min(1), archived: z.boolean(), executable: z.string(), profile: z.string() }).strict().parse(args);
        return harnessMutation(async () => {
          applicationWorkspace.assertConfirmed();
          const settings = applicationWorkspace.snapshot().settings;
          if (settings.codexExecutable !== value.executable || settings.codexProfile !== value.profile) throw new Error('CODEX_PROFILE_CHANGED: Switch back to the original profile before undoing this archive.');
          return codex.setArchived(value.sessionId, value.archived);
        });
      }
      if (name === 'harnessRefresh') {
        await harnessSync.refresh();
        workspaceRefresh();
        return codex.snapshot();
      }
      if (name === 'harnessCheck') return codex.checkCompatibility();
      if (name === 'harnessRead') {
        const { sessionId } = z.object({ sessionId: z.string().min(1) }).strict().parse(args);
        return codex.read(sessionId);
      }
      if (name === 'paneDocument' || name === 'paneView' || name === 'paneAnnotationState') {
        const value = z.object({ key: z.string().min(1), paneId: z.string().min(1),
          artifactId: z.string().min(1).optional(),
          revisionId: z.string().min(1).nullable().optional(),
          scrollTop: z.number().finite().nonnegative().optional(),
          view: z.object({ details: z.record(z.string(), z.boolean()) }).optional(),
        }).strict().parse(args);
        const content = applicationWorkspace.findPane(value.key, value.paneId).content;
        if (content.kind !== 'plan' || content.tab.kind !== 'document') throw new Error('DOCUMENT_PANE_REQUIRED');
        const identity = { artifactId: content.artifactId, revisionId: content.tab.revisionId };
        // An old iframe may still be mounted while the shell catches up with a
        // main-process selection. Never give it another revision's editable state.
        if (name === 'paneDocument' &&
          ((value.artifactId !== undefined && value.artifactId !== identity.artifactId) ||
            (value.revisionId !== undefined && value.revisionId !== identity.revisionId)))
          throw new Error('DOCUMENT_PANE_CHANGED: The document view has changed.');
        if (name === 'paneView') return applicationMutation(async () => {
          if (identity.revisionId && value.view) {
            const context = await rpc('captureAnnotationState', { ...identity, view: value.view }) as import('../shared/annotation-context').AnnotationStateContext;
            applicationWorkspace.view(value.key, value.paneId, { details: context.view.details,
              ...(value.scrollTop === undefined ? {} : { scrollTop: value.scrollTop }) });
            return context.view;
          }
          if (value.scrollTop !== undefined) applicationWorkspace.view(value.key, value.paneId, { scrollTop: value.scrollTop });
          return { details: content.details ?? {} };
        });
        if (name === 'paneAnnotationState') {
          if (!identity.revisionId) throw new Error('PUBLISHED_DOCUMENT_REQUIRED');
          return rpc('captureAnnotationState', { ...identity, view: value.view ?? { details: content.details ?? {} } });
        }
        const document = await rpc('getDocument', identity) as { view?: import('../shared/annotation-context').DocumentView; annotationState?: unknown };
        const view = { details: content.details ?? document.view?.details ?? {} };
        return { ...document, view, scrollTop: content.scrollTop ?? 0,
          annotationState: identity.revisionId ? await rpc('captureAnnotationState', { ...identity, view }) : null };
      }
      if (name === 'applicationSettings') {
        const requested = applicationSettingsSchema.parse(args);
        return applicationMutation(async () => {
          const previous = applicationWorkspace.snapshot().settings;
          const profileChanged = previous.codexExecutable !== requested.codexExecutable || previous.codexProfile !== requested.codexProfile;
          const update = async () => {
            applicationWorkspace.settings(requested);
            await terminals.configure({ scrollback: requested.terminalScrollback });
            if (profileChanged) await codex.resetDiscovery();
            return applicationWorkspace.snapshot();
          };
          return profileChanged ? harnessMutation(update) : update();
        });
      }
      if (['terminalScreen', 'terminalReplay', 'terminalInput', 'terminalResize', 'terminalStop', 'terminalRestart'].includes(name)) {
        const value = z.object({ id: z.string().min(1), data: z.string().max(1024 * 1024).optional(),
          viewId: z.string().min(1).optional(), cols: z.number().int().min(2).max(500).optional(),
          rows: z.number().int().min(1).max(300).optional(), active: z.boolean().optional(),
          afterSeq: z.number().int().nonnegative().optional() }).strict().parse(args);
        if (name === 'terminalScreen') return terminals.screen(value.id);
        if (name === 'terminalReplay') return terminals.replay(value.id, value.afterSeq ?? 0);
        if (name === 'terminalInput') {
          if (!value.viewId || value.data === undefined) throw new Error('Invalid terminal input');
          await terminals.input(value.id, value.data, value.viewId); return { accepted: true };
        }
        if (name === 'terminalResize') {
          if (!value.viewId || value.cols === undefined || value.rows === undefined) throw new Error('Invalid terminal dimensions');
          await terminals.resize(value.id, { cols: value.cols, rows: value.rows, viewId: value.viewId, active: value.active === true });
          return { resized: true };
        }
        if (name === 'terminalStop') {
          if (!window) throw new Error('Terminal window unavailable');
          const answer = await dialog.showMessageBox(window, { type: 'warning',
            message: 'Stop this terminal process?', detail: 'The process and its owned children will be terminated. Closing a view leaves them running.',
            buttons: ['Cancel', 'Stop'], defaultId: 0, cancelId: 0 });
          if (answer.response !== 1) return { stopped: false };
          return terminals.stop(value.id);
        }
        const settings = applicationWorkspace.snapshot().settings;
        return terminals.restart(value.id, { executable: settings.shell || undefined, args: settings.shellArgs });
      }
      if (name === 'applicationCommand') {
        const value = z.object({ action: z.enum(['projectOverview', 'select', 'selectTab', 'focus', 'closeTab', 'closePane', 'newTerminal', 'showTerminal', 'newCodex', 'openPlan', 'openHome', 'address', 'openUrl', 'selectVersion', 'split', 'ratio', 'view', 'bottomToggle', 'bottomHeight', 'bottomSelect', 'bottomClose']),
          projectId: z.string().min(1), sessionId: z.string().min(1).nullable().optional(),
          key: z.string().optional(), tabId: z.string().optional(), paneId: z.string().optional(),
          artifactId: z.string().optional(), revisionId: z.string().nullable().optional(), terminalId: z.string().optional(),
          url: z.string().max(10000).optional(),
          area: z.enum(['main', 'bottom']).optional(), axis: z.enum(['horizontal', 'vertical']).optional(),
          ratio: z.number().min(0.1).max(0.9).optional(), height: z.number().int().min(120).max(800).optional(),
          scrollTop: z.number().finite().nonnegative().optional(), details: z.record(z.string(), z.boolean()).optional(),
          operationId: z.uuid().optional() }).strict().parse(args);
        return applicationMutation(async () => {
          if (!['view', 'ratio', 'bottomHeight'].includes(value.action)) await browser?.finishComment();
          const snapshot = await rpc('snapshot') as { projects: { id: string; path: string; available?: boolean }[]; artifacts: { id: string; projectId: string }[] };
          const project = snapshot.projects.find(project => project.id === value.projectId);
          if (!project) throw new Error('PROJECT_NOT_FOUND');
          const key = value.key ?? applicationWorkspace.select(value.projectId, value.sessionId ?? null);
          if (applicationWorkspace.workspace(key).projectId !== project.id) throw new Error('WORKSPACE_PROJECT_MISMATCH');
          if (value.action === 'focus' && applicationWorkspace.snapshot().selectedSurface === 'project') return applicationWorkspace.snapshot();
          if (value.action === 'projectOverview') {
            applicationWorkspace.showProject(project.id);
            await rpc('selectProject', { projectId: project.id });
            browser?.select(null);
          } else if (value.action === 'select') {
            applicationWorkspace.select(project.id, applicationWorkspace.workspace(key).sessionId);
            await rpc('selectProject', { projectId: project.id });
            const selected = applicationWorkspace.workspace(key);
            if (selected.activePaneId && project.available !== false) await activateApplicationPane(key, selected.activePaneId);
            else browser?.select(null);
          } else if (value.action === 'focus' || value.action === 'selectTab') {
            if (value.action === 'selectTab') {
              if (!value.tabId) throw new Error('TAB_REQUIRED');
              applicationWorkspace.selectTab(key, value.tabId);
            }
            const paneId = value.paneId ?? applicationWorkspace.workspace(key).activePaneId;
            if (paneId) await activateApplicationPane(key, paneId);
          } else if (value.action === 'openPlan' || value.action === 'openHome') {
            const artifact = snapshot.artifacts.find(artifact => artifact.id === value.artifactId && artifact.projectId === project.id);
            if (!artifact) throw new Error('ARTIFACT_NOT_FOUND');
            const tab = value.action === 'openHome' ? workspace.home(artifact.id) : workspace.document(artifact.id, value.revisionId ?? null);
            const pane = applicationWorkspace.openPlan(key, artifact.id, tab);
            await activateApplicationPane(key, pane.id);
            await workspace.save();
          } else if (['address', 'openUrl', 'selectVersion'].includes(value.action)) {
            if (!value.paneId) throw new Error('PANE_REQUIRED');
            const content = applicationWorkspace.findPane(key, value.paneId).content;
            if (content.kind !== 'plan') throw new Error('PLAN_PANE_REQUIRED');
            if (value.action === 'address') {
              if (content.tab.kind !== 'home') throw new Error('HOME_PANE_REQUIRED');
              content.tab.address = value.url ?? '';
            } else if (value.action === 'selectVersion') {
              if (content.tab.kind !== 'document') throw new Error('DOCUMENT_PANE_REQUIRED');
              await rpc('getDocument', { artifactId: content.artifactId, revisionId: value.revisionId ?? null });
              content.tab.revisionId = value.revisionId ?? null;
              delete content.details;
              content.scrollTop = 0;
              await activateApplicationPane(key, value.paneId);
            } else {
              if (!browser || !value.url) throw new Error('URL_REQUIRED');
              if (content.tab.kind !== 'home' && content.tab.kind !== 'browser') throw new Error('BROWSER_PANE_REQUIRED');
              if (content.tab.kind === 'browser' && content.tab.nativeId) {
                await browser.command({ tabId: content.tab.nativeId, action: 'navigate', url: value.url });
              } else {
                const native = await browser.open({ projectId: project.id, artifactId: content.artifactId, url: value.url, newTab: true });
                applicationWorkspace.planTab(key, value.paneId, { id: content.tab.id, kind: 'browser',
                  nativeId: native.id, title: native.title, url: native.url });
                workspace.browser(content.artifactId, native, content.tab.id);
                await workspace.save();
              }
            }
          } else if (value.action === 'closeTab' || value.action === 'closePane') {
            const candidate = applicationWorkspace.workspace(key).tabs.find(tab => tab.id === value.tabId);
            if (value.action === 'closeTab' && candidate && paneLeaves(candidate.root).some(pane => pane.content.kind === 'session')) return { closed: false, pinned: true };
            if (value.action === 'closePane' && value.paneId && applicationWorkspace.findPane(key, value.paneId).content.kind === 'session') return { closed: false, pinned: true };
            // Detect a failed local write before destroying the external page.
            await applicationWorkspace.save();
            const current = applicationWorkspace.workspace(key);
            const panes = value.action === 'closePane' && value.paneId ? [applicationWorkspace.findPane(key, value.paneId)] :
              current.tabs.find(tab => tab.id === value.tabId)?.root;
            const leaves = Array.isArray(panes) ? panes : panes ? paneLeaves(panes) : [];
            for (const pane of leaves) if (pane.content.kind === 'plan' && pane.content.tab.kind === 'browser' && pane.content.tab.nativeId) {
              const result = await browser?.command({ tabId: pane.content.tab.nativeId, action: 'close' });
              if (result && 'cancelled' in result && result.cancelled) return { closed: false };
            }
            if (value.action === 'closePane' && value.paneId) applicationWorkspace.closePane(key, value.paneId);
            else if (value.tabId) applicationWorkspace.closeTab(key, value.tabId);
            const active = applicationWorkspace.workspace(key).activePaneId;
            if (active) await activateApplicationPane(key, active); else browser?.select(null);
          } else if (value.action === 'ratio') {
            if (!value.paneId || value.ratio === undefined) throw new Error('SPLIT_REQUIRED');
            applicationWorkspace.ratio(key, value.paneId, value.ratio);
          } else if (value.action === 'view') {
            if (!value.paneId) throw new Error('PANE_REQUIRED');
            applicationWorkspace.view(key, value.paneId, { scrollTop: value.scrollTop, details: value.details });
          } else if (value.action.startsWith('bottom')) {
            const bottom = applicationWorkspace.bottom(project.id);
            if (value.action === 'bottomToggle') bottom.visible = !bottom.visible;
            if (value.action === 'bottomHeight') bottom.height = value.height ?? bottom.height;
            if (value.action === 'bottomSelect' && value.terminalId && bottom.tabs.includes(value.terminalId)) bottom.activeTerminalId = value.terminalId;
            if (value.action === 'bottomClose' && value.terminalId) {
              bottom.tabs = bottom.tabs.filter(id => id !== value.terminalId);
              if (bottom.activeTerminalId === value.terminalId) bottom.activeTerminalId = bottom.tabs[0] ?? null;
            }
          } else {
            if (project.available === false) throw new Error('PROJECT_UNAVAILABLE');
            const settings = applicationWorkspace.snapshot().settings;
            const records = await terminals.snapshot();
            let terminal = value.terminalId ? records.find(record => record.id === value.terminalId && record.projectId === project.id) :
              value.operationId ? records.find(record => record.operationId === value.operationId) : undefined;
            if (value.action === 'showTerminal' && !terminal) throw new Error('TERMINAL_NOT_FOUND');
            if (!terminal && value.action === 'newCodex') {
              const launch = value.sessionId ? await codex.launchResume(project.id, project.path, value.sessionId) : await codex.launchNew(project.id, project.path);
              try {
                terminal = await terminals.create({ projectId: project.id, cwd: launch.cwd, kind: 'codex', executable: launch.executable,
                  args: launch.args, env: launch.env, operationId: value.operationId, harnessSessionId: value.sessionId ?? undefined });
                codex.bindTerminal(launch.launchId, terminal.id);
              } catch (error) { await codex.cancelLaunch(launch.launchId); throw error; }
            }
            if (!terminal) {
              const active = applicationWorkspace.workspace(key).activePaneId;
              const content = value.paneId ? applicationWorkspace.findPane(key, value.paneId).content : active ? applicationWorkspace.findPane(key, active).content : null;
              const cwd = (content?.kind === 'terminal' || content?.kind === 'session') && content.terminalId ? await terminals.currentCwd(content.terminalId) : project.path;
              terminal = await terminals.create({ projectId: project.id, cwd, kind: 'shell', executable: settings.shell || undefined, args: settings.shellArgs, operationId: value.operationId });
            }
            if (value.area === 'bottom') applicationWorkspace.bottomTerminal(project.id, terminal.id);
            else if (value.action === 'split' && value.paneId)
              applicationWorkspace.split(key, value.paneId, value.axis ?? 'horizontal', { kind: 'terminal', terminalId: terminal.id });
            else if (terminal.kind === 'codex' && applicationWorkspace.workspace(key).sessionId === terminal.harnessSessionId) applicationWorkspace.bindSessionTerminal(key, terminal.id);
            else applicationWorkspace.terminal(key, terminal.id);
            browser?.select(null);
          }
          return applicationWorkspace.snapshot();
        });
      }
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
        return new Promise<{ action: 'new' | 'refresh' | 'locate' | 'remove' | null }>((resolve) => {
          const menu = Menu.buildFromTemplate([
            {
              label: 'New session',
              enabled: project.available !== false,
              click: () => resolve({ action: 'new' }),
            },
            { label: 'Refresh sessions', click: () => resolve({ action: 'refresh' }) },
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
        const properties = await rpc('artifactProperties', { artifactId }) as { archived?: boolean };
        if (!window || window.isDestroyed()) throw new Error('Plan window unavailable');
        const target = window;
        return new Promise<{ action: 'rename' | 'archive' | 'restore' | null }>((resolve) => {
          const menu = Menu.buildFromTemplate([
            { label: 'Rename plan', click: () => resolve({ action: 'rename' }) },
            { label: properties.archived ? 'Restore plan' : 'Archive plan', click: () => resolve({ action: properties.archived ? 'restore' : 'archive' }) },
          ]);
          menu.popup({ window: target, callback: () => resolve({ action: null }) });
        });
      }
      if (name === 'archivePlan') {
        const input = z.object({ artifactId: z.string().min(1), archived: z.boolean(), operationId: z.uuid() }).strict().parse(args);
        await browser?.finishComment();
        const result = await rpc('archivePlan', input);
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
          if (!workspace.hasPendingConfirmation()) workspace.restore(previous);
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
      if (name === 'browserViews' && browser) {
        const value = z.object({ views: z.array(z.object({ viewId: z.string().min(1), tabId: z.string().optional(),
          active: z.boolean(), bounds: z.object({ x: z.number().finite(), y: z.number().finite(),
            width: z.number().finite().positive(), height: z.number().finite().positive() }) })).max(64) }).strict().parse(args);
        const key = applicationWorkspace.snapshot().selectedWorkspace;
        if (!key || applicationWorkspace.snapshot().selectedSurface === 'project') { browser.setVisibleViews([]); return { updated: true }; }
        const current = applicationWorkspace.workspace(key);
        const selected = current.tabs.find(tab => tab.id === current.activeTabId);
        const leaves = selected ? paneLeaves(selected.root) : [];
        const bindings: import('./browser').BrowserViewBinding[] = [];
        let restored = false;
        for (const view of value.views) {
          const pane = leaves.find(pane => pane.id === view.viewId);
          if (!pane || pane.content.kind !== 'plan' || pane.content.tab.kind !== 'browser') throw new Error('BROWSER_PANE_CHANGED');
          const content = pane.content;
          const tab = content.tab;
          if (tab.kind !== 'browser') throw new Error('BROWSER_PANE_REQUIRED');
          if (!tab.nativeId || !browser.snapshot().tabs.some(native => native.id === tab.nativeId)) {
            const native = await ensureApplicationBrowser(key, pane.id);
            tab.nativeId = native.id; restored = true;
          }
          bindings.push({ ...view, tabId: tab.nativeId, active: current.activePaneId === pane.id });
        }
        browser.setVisibleViews(bindings);
        if (restored) workspaceRefresh();
        return { updated: true };
      }
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
            input.paneId === undefined ? undefined : z.string().parse(input.paneId),
          );
        }
        if (name === 'browserRestoreDraft') {
          const artifactId = z.string().parse(input.artifactId);
          const owner = browser;
          return applicationMutation(async () => {
            const draft = (await rpc('browserEditor', { artifactId })) as
              Parameters<BrowserManager['restoreDraft']>[0] | null;
            if (!draft) return { restored: false };
            browserDraftArtifact = artifactId;
            const artifact = (await rpc('artifactProperties', { artifactId })) as {
              id: string;
              projectId: string;
            };
            const key = applicationWorkspace.snapshot().selectedWorkspace;
            if (!key || applicationWorkspace.workspace(key).projectId !== artifact.projectId)
              throw new Error('BROWSER_DRAFT_WORKSPACE_CHANGED');
            const current = applicationWorkspace.workspace(key);
            const panes = current.tabs.flatMap(tab => paneLeaves(tab.root));
            const matches = (pane: typeof panes[number]) => pane.content.kind === 'plan' &&
              pane.content.artifactId === artifactId && pane.content.tab.kind === 'browser';
            const pane = panes.find(pane => pane.id === current.activePaneId && matches(pane)) ??
              panes.find(pane => matches(pane) && pane.content.kind === 'plan' && pane.content.tab.kind === 'browser' &&
                pane.content.tab.url === draft.capture.source.url);
            if (!pane || pane.content.kind !== 'plan' || pane.content.tab.kind !== 'browser')
              throw new Error('BROWSER_DRAFT_PANE_NOT_FOUND');
            const opened = await ensureApplicationBrowser(key, pane.id);
            workspace.browser(artifactId, opened, pane.content.tab.id);
            await workspace.save();
            if (browser !== owner) throw new Error('Browser surface changed during restoration');
            owner.select(opened.id);
            await owner.restoreDraft({ ...draft, tabId: opened.id });
            await setEditingScope('browser', true);
            return { restored: true };
          });
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
            paneId: z.string().optional(),
          })
          .strict()
          .parse(args);
        await rpc('getDocument', { artifactId: input.artifactId, revisionId: input.revisionId });
        const current = (await rpc('snapshot')) as {
          selected: { artifactId: string; revisionId: string } | null;
        };
        if (input.paneId) {
          const key = applicationWorkspace.snapshot().selectedWorkspace;
          if (!key) throw new Error('Document workspace changed');
          const entry = applicationWorkspace.workspace(key);
          const active = entry.tabs.find(tab => tab.id === entry.activeTabId);
          const pane = active && paneLeaves(active.root).find(pane => pane.id === input.paneId);
          if (!pane || pane.content.kind !== 'plan' || pane.content.artifactId !== input.artifactId ||
              pane.content.tab.kind !== 'document' || pane.content.tab.revisionId !== input.revisionId)
            throw new Error('Document pane changed');
        } else if (
          current.selected?.artifactId !== input.artifactId ||
          current.selected.revisionId !== input.revisionId
        )
          throw new Error('Document selection changed');
        validateArea(input.rect, input.viewport);
        if (input.pointer.x > input.viewport.width || input.pointer.y > input.viewport.height)
          throw new Error('INVALID_POINTER: Pointer exceeds viewport');
        const frameBounds = await window.webContents.executeJavaScript(
          `(()=>{const id=${JSON.stringify(input.paneId ?? null)};const f=id?Array.from(document.querySelectorAll('iframe')).find(f=>f.dataset.paneId===id):document.querySelector('iframe');if(!f)throw Error('Document not visible');const b=f.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}})()`,
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
        const registerAndSelect = (command: string, value: Record<string, unknown>) => applicationMutation(async () => {
          await browser?.finishComment();
          const project = await rpc(command, value) as { id: string };
          applicationWorkspace.showProject(project.id);
          await rpc('selectProject', { projectId: project.id }); browser?.select(null);
          void harnessSync.refresh().catch(() => {});
          return project;
        });
        try {
          return await registerAndSelect('register', { path });
        } catch (error) {
          const conflict = error as Error & {
            code?: string;
            details?: { projectId?: string; originalPath?: string };
          };
          if (conflict.code !== 'PROJECT_ID_CONFLICT' || !conflict.details?.projectId) throw error;
          const answer = await dialog.showMessageBox(window!, {
            type: 'question',
            message: 'This folder copies an existing Projector project',
            detail: `Registered original: ${conflict.details.originalPath}. A new empty project preserves copied history in a backup folder and imports no private work.`,
            buttons: ['Cancel', 'Open original', 'Create empty project'],
            defaultId: 0,
            cancelId: 0,
          });
          if (answer.response === 1) {
            return registerAndSelect('register', { path: conflict.details.originalPath });
          }
          if (answer.response === 2)
            return registerAndSelect('registerCopy', { path, projectId: conflict.details.projectId });
          return null;
        }
      }
      if (name === 'locateProject') {
        const projectId = z.object({ projectId: z.string() }).parse(args).projectId;
        const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] });
        if (result.canceled) return null;
        const relocated = await rpc('relocateProject', { projectId, path: result.filePaths[0] });
        void harnessSync.refresh().catch(() => {});
        return relocated;
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
        let removalAcknowledged = false;
        const deselect = () => {
          const value = applicationWorkspace.snapshot();
          if (!value.selectedWorkspace || value.workspaces[value.selectedWorkspace]?.projectId !== projectId)
            return;
          applicationWorkspace.restore({ ...value, selectedWorkspace: null });
          browser?.select(null);
          browser?.setVisibleViews([]);
        };
        try {
          return await applicationMutation(async () => {
            await browser?.finishComment();
            const result = await rpc('removeProject', { projectId });
            removalAcknowledged = true;
            void harnessSync.refresh().catch(() => {});
            deselect();
            const currentBrowser = browser?.snapshot();
            if (currentBrowser?.tabs.some(tab => tab.id === currentBrowser.activeTabId && tab.projectId === projectId))
              browser?.select(null);
            return result;
          });
        } catch (error) {
          // Registration was already removed. A known metadata failure cannot
          // restore an active selection that is no longer registered.
          if (removalAcknowledged && !applicationWorkspace.hasPendingConfirmation()) deselect();
          workspaceRefresh();
          throw error;
        }
      }
      if (name === 'setup') {
        return getMcpSetup({
          isPackaged: app.isPackaged,
          development: Boolean(developmentUrl),
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
          descriptorPath,
          nodeOverride: process.env.PROJECTOR_NODE,
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
      if (name === 'copyUpdateMessage') {
        const value = z.object({ artifactId: z.string().min(1), savedStateId: z.string().min(1),
          sessionId: z.string().min(1).optional() }).strict().parse(args);
        const snapshot = await rpc('snapshot') as { artifacts: { id: string; projectId: string }[];
          savedStates: { id: string; artifactId: string }[] };
        const artifact = snapshot.artifacts.find(item => item.id === value.artifactId);
        if (!artifact || !snapshot.savedStates.some(state => state.id === value.savedStateId && state.artifactId === artifact.id))
          throw new Error('SAVED_STATE_NOT_FOUND');
        const target = value.sessionId ? codex.snapshot().sessions.find(session => session.id === value.sessionId && session.projectId === artifact.projectId) : null;
        const terminal = target?.terminalId ? (await terminals.snapshot()).find(record => record.id === target.terminalId && record.status === 'running') : null;
        if (value.sessionId && !terminal) throw new Error('CODEX_TERMINAL_NOT_RUNNING: Resume the selected session explicitly before copying to its terminal.');
        const text = `Projector projectId="${artifact.projectId}", artifactId="${artifact.id}", savedStateId="${value.savedStateId}". Call read_artifact({artifactId:"${artifact.id}",part:"state",savedStateId:"${value.savedStateId}"}), follow every cursor, and read its attachments with read_attachment. This saved context does not authorize implementation.`;
        await clipboard.writeText(text);
        if (target && terminal) await applicationMutation(async () => {
          const key = applicationWorkspace.select(artifact.projectId, target.id);
          const pane = applicationWorkspace.terminal(key, terminal.id);
          await activateApplicationPane(key, pane.id);
        });
        return { copied: true, text };
      }
      if (name === 'openArtifact') {
        const value = z.object({ artifactId: z.string().min(1), revisionId: z.string().nullable() }).strict().parse(args);
        return applicationMutation(() => applicationPlan(value.artifactId, value.revisionId));
      }
      if (name === 'editing') {
        const value = z.object({ active: z.boolean(), scope: z.string().min(1).max(1024).optional() }).strict().parse(args);
        return setEditingScope(value.scope ?? 'operator', value.active);
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
        'demo',
      ];
      if (!allowed.includes(name)) throw new Error('Unsupported operator command');
      return rpc(name, args);
    });
    const activeKey = applicationWorkspace.snapshot().selectedWorkspace;
    const active = activeKey ? applicationWorkspace.workspace(activeKey) : null;
    if (active) {
      const state = await rpc('snapshot') as { projects: { id: string; available?: boolean }[] };
      const project = state.projects.find(project => project.id === active.projectId);
      // An unavailable folder must leave a recoverable workspace, rather than
      // making renderer startup depend on reading the missing document.
      if (applicationWorkspace.snapshot().selectedSurface !== 'project' && activeKey && active.activePaneId && project?.available !== false && project)
        await activateApplicationPane(activeKey, active.activePaneId);
      else if (project) await rpc('selectProject', { projectId: active.projectId });
    }
    createWindow();
    harnessSync.start();
  })
  .catch(async (error) => {
    console.error(error);
    quitting = true;
    await quitAfterCleanup();
  });
