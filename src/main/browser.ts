import {
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  screen,
  dialog,
  shell,
  type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { runtimeLimits } from '../shared/runtime-limits';
import { markerGeometry } from '../shared/annotation-marker';
import { z } from 'zod';
import { browserOverlayHtml, browserMarkerHtml } from './browser-overlay-html';
import {
  browserPartition,
  browserUrl,
  safeBrowserBounds,
  validateArea,
  browserStateHash,
  type BrowserElementAnchor,
  type AreaRect,
} from './browser-policy';

const abortedNavigation = -3;
function isAbortedNavigation(error: unknown): boolean {
  return error instanceof Error &&
    (('errno' in error && error.errno === abortedNavigation) ||
      ('code' in error && error.code === 'ERR_ABORTED'));
}

type OverlayHandler = (event: Electron.IpcMainInvokeEvent, action: unknown, value: unknown) => unknown;
const retiredOverlayContents = new WeakSet<WebContents>();
let overlayHandler: OverlayHandler | undefined;
let overlayIpcBound = false;
function bindOverlayHandler(handler: OverlayHandler): () => void {
  if (!overlayIpcBound) {
    // IPC belongs to the process. Native renderer closure is asynchronous, so
    // its retired sender may still deliver already queued messages afterward.
    ipcMain.handle('projector:browser-overlay', (event, action: unknown, value: unknown) => {
      if (retiredOverlayContents.has(event.sender))
        return { captureError: 'CAPTURE_CHANGED: The annotation tool was closed. Select again.' };
      if (!overlayHandler) throw new Error('Untrusted browser overlay sender');
      return overlayHandler(event, action, value);
    });
    overlayIpcBound = true;
  }
  overlayHandler = handler;
  return () => { if (overlayHandler === handler) overlayHandler = undefined; };
}

export type BrowserTab = {
  id: string;
  artifactId: string;
  projectId: string;
  url: string;
  title: string;
  loading: boolean;
  zoomFactor: number;
  error: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  pageId?: string;
  stateHash?: string;
};
export type BrowserCapture = {
  id: string;
  png: string;
  source: {
    kind: 'browser-area';
    url: string;
    title: string;
    capturedAt: string;
    viewport: { width: number; height: number; deviceScaleFactor: number };
    rect?: AreaRect;
    pointer?: { x: number; y: number };
    zoomFactor: number;
    scroll: { x: number; y: number };
    pageId?: string;
    stateHash?: string;
    layoutHash?: string;
    elementAnchor?: BrowserElementAnchor;
  };
};
type CaptureDraft = { capture: BrowserCapture; comment: string };
export type BrowserViewBinding = {
  viewId: string;
  tabId: string;
  bounds: AreaRect;
  active: boolean;
};
export type BrowserHooks = {
  overlayPreload: string;
  onChange: () => void;
  onTabOpened?: (tab: BrowserTab, background: boolean) => void;
  onViewFocus?: (value: { viewId: string; tabId: string }) => void | Promise<void>;
  hasUnfinishedEditor?: () => boolean;
  onShortcut?: (input: Electron.Input) => boolean;
  getRevision?: (artifactId: string) => Promise<string | null>;
  getAnnotations?: (artifactId: string) => Promise<BrowserMarkerAnnotation[]>;
  onMarkerSelect?: (value: { artifactId: string; annotationId: string }) => Promise<unknown>;
  onAnnotation: (
    value: CaptureDraft & { artifactId: string; tabId: string; revisionId?: string | null },
  ) => Promise<{ id: string; number: number }>;
  onDraft?: (
    value:
      (CaptureDraft & { artifactId: string; tabId: string; revisionId?: string | null }) | null,
  ) => Promise<unknown>;
};
export type BrowserMarkerAnnotation = {
  id: string;
  number: number;
  capture?: { source: BrowserCapture['source'] };
};
type InternalTab = {
  state: BrowserTab;
  view: WebContentsView;
  contents: WebContents;
  documentId: string;
  entries: Map<number, string>;
  annotations: BrowserMarkerAnnotation[];
  navigationEpoch: number;
  gestureAt: number;
  grants: Set<string>;
  suppressedMouseButtons: Set<string>;
  downloadNavigation?: string;
};
type PageProbe = {
  url: string;
  title: string;
  scroll: { x: number; y: number };
  history: unknown;
  navigationKey: string | null;
  semantic: string;
  layout: unknown;
  viewport: { width: number; height: number };
  anchors: {
    id: string;
    rect: AreaRect | null;
    bounds: AreaRect | null;
    text: string;
    tag: string;
    elementId?: string;
  }[];
};
const areaSchema = z
  .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
  .strict();
const editSchema = z
  .object({ captureId: z.string(), rect: areaSchema.nullable(), comment: z.string().max(20000) })
  .strict();
const overlayPointerSchema = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  deltaX: z.number().finite().optional(),
  deltaY: z.number().finite().optional(),
}).strict();
const overlaySelectionSchema = z.object({
  point: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  rect: areaSchema.nullable(),
}).strict();

class CaptureChangedError extends Error {
  constructor(reason: string) {
    super(`CAPTURE_CHANGED: ${reason} Select again.`);
  }
}

// Shared read-only geometry for hover/selection and persisted element markers.
// A viewport rect alone does not establish visibility inside nested scroll containers.
const visibleElementRectScript = `const visibleRect=el=>{
  const style=getComputedStyle(el);
  if(style.visibility==='hidden'||style.visibility==='collapse'||!el.getClientRects().length)return null;
  const r=el.getBoundingClientRect();
  let left=Math.max(0,r.left),top=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
  for(let parent=el.parentElement;parent;parent=parent.parentElement){
    const css=getComputedStyle(parent),clipX=/^(auto|scroll|hidden|clip)$/.test(css.overflowX),clipY=/^(auto|scroll|hidden|clip)$/.test(css.overflowY);
    if(!clipX&&!clipY)continue;
    const box=parent.getBoundingClientRect(),scaleX=parent.offsetWidth?box.width/parent.offsetWidth:1,scaleY=parent.offsetHeight?box.height/parent.offsetHeight:1;
    const x=box.left+parent.clientLeft*scaleX,y=box.top+parent.clientTop*scaleY;
    if(clipX){left=Math.max(left,x);right=Math.min(right,x+parent.clientWidth*scaleX)}
    if(clipY){top=Math.max(top,y);bottom=Math.min(bottom,y+parent.clientHeight*scaleY)}
  }
  return right>left&&bottom>top?{x:left,y:top,width:right-left,height:bottom-top}:null;
};`;

export class BrowserManager {
  private tabs = new Map<string, InternalTab>();
  private activeTabId: string | null = null;
  private bounds: AreaRect = { x: 0, y: 0, width: 0, height: 0 };
  private nonBrowserBounds: AreaRect | null = null;
  private visibleViews: Map<string, BrowserViewBinding> | null = null;
  private attachedTabs = new Set<string>();
  private layoutGeneration = 0;
  private resizing = false;
  private focusRequest: string | null = null;
  private pendingEditorFocus = new Set<string>();
  private overlay: WebContentsView | null = null;
  private overlayReady: Promise<void> | null = null;
  private overlayContents: WebContents | null = null;
  private closeOperations = new Map<string, Promise<boolean>>();
  private capture:
    | (CaptureDraft & {
        artifactId: string;
        tabId: string;
        revisionId?: string | null;
        readonly?: boolean;
        number?: number;
      })
    | null = null;
  private captureGeneration = 0;
  private closed = false;
  private operationChain: Promise<unknown> = Promise.resolve();
  private tool: { tabId: string; revisionId?: string | null } | null = null;
  private markerViews = new Map<
    string,
    { view: WebContentsView; contents: WebContents; artifactId: string; annotationId: string }
  >();
  private markerTimer: ReturnType<typeof setInterval>;
  private releaseOverlayHandler: () => void;
  private markerBusy = false;
  private downloadItems = new Map<Electron.DownloadItem, string>();
  private downloads: {
    id: string;
    tabId: string;
    filename: string;
    status: string;
    path?: string;
  }[] = [];
  private downloadGuards = new Map<
    string,
    {
      session: Electron.Session;
      listener: (event: Electron.Event, item: Electron.DownloadItem, contents: WebContents) => void;
    }
  >();

  constructor(
    private window: BrowserWindow,
    private hooks: BrowserHooks,
    private profileData?: string,
  ) {
    this.releaseOverlayHandler = bindOverlayHandler((event, action, value) => {
      const marker = [...this.markerViews.values()].find((m) => m.contents === event.sender);
      if (marker && event.senderFrame === event.sender.mainFrame) {
        if (action !== 'marker') throw new Error('Unsupported marker operation');
        return this.hooks.onMarkerSelect?.({
          artifactId: marker.artifactId,
          annotationId: marker.annotationId,
        });
      }
      if (
        !this.overlay ||
        event.sender !== this.overlayContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error('Untrusted browser overlay sender');
      // Serialize draft writes and submission so the final composer value cannot be overwritten.
      const generation = this.captureGeneration;
      const next = this.operationChain
        .catch(() => {})
        .then(() => this.overlayAction(action, value, generation));
      this.operationChain = next;
      return next.catch((error: unknown) => {
        // A stale selection is an expected, recoverable tool result, not an IPC failure.
        if (error instanceof CaptureChangedError) return { captureError: error.message };
        throw error;
      });
    });
    this.markerTimer = setInterval(() => {
      void this.refreshMarkers().catch(() => {});
    }, 200);
    this.markerTimer.unref();
    window.once('closed', () => this.dispose());
  }

  snapshot() {
    return {
      tabs: [...this.tabs.values()].map(({ state }) => ({ ...state })),
      activeTabId: this.activeTabId,
      downloads: this.downloads.map((value) => ({ ...value })),
      annotating: Boolean(this.tool || (this.capture && !this.capture.readonly)),
    };
  }

  async open(args: {
    artifactId: string;
    projectId: string;
    url: string;
    newTab?: boolean;
    background?: boolean;
  }) {
    if (this.tool) this.hideOverlay();
    if (this.capture && !this.capture.readonly)
      throw new Error('UNFINISHED_COMMENT: Save or cancel the area annotation first.');
    const url = browserUrl(args.url);
    const existing = [...this.tabs.values()].find(
      ({ state }) => state.artifactId === args.artifactId && state.url === url,
    );
    if (existing && !args.newTab) {
      this.select(existing.state.id);
      return { ...existing.state };
    }
    const partition = browserPartition(args.projectId, this.profileData);
    const projectSession = session.fromPartition(partition);
    this.configureSession(partition, projectSession);
    const view = new WebContentsView({
      webPreferences: {
        session: projectSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const state: BrowserTab = {
      id: randomUUID(),
      artifactId: args.artifactId,
      projectId: args.projectId,
      url,
      title: url,
      loading: true,
      zoomFactor: 1,
      error: null,
      canGoBack: false,
      canGoForward: false,
    };
    const contents = view.webContents;
    const internal: InternalTab = {
      state,
      view,
      contents,
      documentId: randomUUID(),
      entries: new Map(),
      annotations: [],
      navigationEpoch: 0,
      gestureAt: 0,
      grants: new Set(),
      suppressedMouseButtons: new Set(),
    };
    this.tabs.set(state.id, internal);
    contents.once('destroyed', () => this.unregisterTab(internal));
    const update = () => {
      if (contents.isDestroyed()) return;
      state.loading = contents.isLoading();
      state.canGoBack = contents.navigationHistory.canGoBack();
      state.canGoForward = contents.navigationHistory.canGoForward();
      this.hooks.onChange();
    };
    const guard = (event: Electron.Event, target: string) => {
      try {
        browserUrl(target);
      } catch {
        event.preventDefault();
        state.error = 'Only HTTP and HTTPS navigation is allowed.';
        update();
      }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-frame-navigate', (event) => guard(event, event.url));
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('before-mouse-event', (event, input) => {
      const button = input.button ?? 'left';
      if (input.type === 'mouseUp' && internal.suppressedMouseButtons.delete(button)) {
        event.preventDefault();
        return;
      }
      if (input.type === 'mouseDown' && this.viewFocused(internal, event)) {
        internal.suppressedMouseButtons.add(button);
        return;
      }
      if (input.type === 'mouseDown' || input.type === 'mouseUp') internal.gestureAt = Date.now();
    });
    contents.on('focus', () => this.viewFocused(internal));
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown') internal.gestureAt = Date.now();
      if (this.hooks.onShortcut?.(input)) event.preventDefault();
    });
    contents.setWindowOpenHandler((details) => {
      const gesture = Date.now() - internal.gestureAt < 1000;
      internal.gestureAt = 0;
      if (gesture && !details.postBody) {
        try {
          const target = browserUrl(details.url);
          const background =
            details.disposition === 'background-tab' || this.activeTabId !== state.id;
          void this.open({
            artifactId: state.artifactId,
            projectId: state.projectId,
            url: target,
            newTab: true,
            background,
          })
            .then((tab) => this.hooks.onTabOpened?.(tab, background))
            .catch((error) => {
              state.error = String(error);
              this.hooks.onChange();
            });
        } catch {
          /* Privileged URLs never reach a native view. */
        }
      }
      return { action: 'deny' };
    });
    contents.on('did-start-loading', () => {
      ++internal.navigationEpoch;
      if (this.activeTabId === state.id) this.clearMarkers();
      state.error = null;
      update();
    });
    contents.on('did-stop-loading', update);
    contents.on('did-start-navigation', (event) => {
      if (!event.isMainFrame) return;
      if (Date.now() - internal.gestureAt < 1000) internal.downloadNavigation = event.url;
      try {
        if (new URL(event.url).origin !== new URL(state.url).origin) internal.grants.clear();
      } catch {
        internal.grants.clear();
      }
      ++internal.navigationEpoch;
      if (this.activeTabId === state.id) this.clearMarkers();
      // A live tool has no snapshot yet. Routers may replace scroll metadata in
      // history.state while opening it; selection probes the current entry later.
      // Real document navigation still tears down the uncaptured overlay.
      if (!event.isSameDocument && this.tool?.tabId === state.id) this.hideOverlay();
    });
    contents.on('did-navigate', (_event, current) => {
      internal.documentId = randomUUID();
      internal.entries.clear();
      state.url = current;
      internal.downloadNavigation = undefined;
      update();
    });
    contents.on('did-navigate-in-page', (_event, current, mainFrame) => {
      if (mainFrame) {
        state.url = current;
        ++internal.navigationEpoch;
        // Without a native entry key, an index can be reused by a new forward branch.
        // Invalidate fallback identity on navigation instead of attaching old markers.
        internal.entries.set(contents.navigationHistory.getActiveIndex(), randomUUID());
        if (this.activeTabId === state.id) this.clearMarkers();
      }
      update();
    });
    contents.on('page-title-updated', (_event, title) => {
      state.title = title;
      update();
    });
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== abortedNavigation) {
        state.error = description;
        update();
      }
    });
    contents.on('render-process-gone', (_event, details) => {
      state.error = 'Browser renderer stopped: ' + details.reason;
      state.loading = false;
      this.hooks.onChange();
    });
    if (!args.background) this.select(state.id);
    void this.refreshAnnotations().catch(() => {});
    // Publication/show_content does not focus the window or remote web contents.
    void contents.loadURL(url).catch((error: unknown) => {
      if (!contents.isDestroyed() && !isAbortedNavigation(error)) {
        state.error = error instanceof Error ? error.message : String(error);
        state.loading = false;
        this.hooks.onChange();
      }
    });
    return { ...state };
  }

  private configureSession(partition: string, projectSession: Electron.Session) {
    if (this.downloadGuards.has(partition)) return;
    const listener = (
      event: Electron.Event,
      item: Electron.DownloadItem,
      contents: WebContents,
    ) => {
      const tab = [...this.tabs.values()].find((value) => value.contents === contents);
      if (
        !tab ||
        this.closed ||
        this.activeTabId !== tab.state.id ||
        (Date.now() - tab.gestureAt > 1000 &&
          !item.getURLChain().includes(tab.downloadNavigation ?? ''))
      ) {
        event.preventDefault();
        return;
      }
      tab.gestureAt = 0;
      tab.downloadNavigation = undefined;
      const record: { id: string; tabId: string; filename: string; status: string; path?: string } =
        {
          id: randomUUID(),
          tabId: tab.state.id,
          filename: item.getFilename(),
          status: 'choosing',
        };
      this.downloads.push(record);
      this.hooks.onChange();
      // Choose synchronously inside will-download: returning without setSavePath
      // would allow Electron's implicit download dialog to race the trusted one.
      try {
        const path = dialog.showSaveDialogSync(this.window, {
          title: 'Save download',
          defaultPath: item.getFilename(),
        });
        if (!path || this.closed || contents.isDestroyed()) {
          record.status = 'cancelled';
          event.preventDefault();
        } else {
          record.path = path;
          record.status = 'downloading';
          item.setSavePath(path);
          this.downloadItems.set(item, tab.state.projectId);
          item.on('updated', (_event, state) => {
            record.status = state === 'interrupted' ? 'interrupted' : 'downloading';
            if (!this.closed) this.hooks.onChange();
          });
          item.once('done', (_event, state) => {
            this.downloadItems.delete(item);
            record.status = state;
            if (!this.closed) this.hooks.onChange();
          });
        }
      } catch {
        record.status = 'interrupted';
        event.preventDefault();
      }
      if (!this.closed) this.hooks.onChange();
    };
    projectSession.on('will-download', listener);
    this.downloadGuards.set(partition, { session: projectSession, listener });
    projectSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      const tab = [...this.tabs.values()].find((value) => value.contents === contents);
      if (!tab || !details.isMainFrame) return false;
      const origin = new URL(tab.state.url).origin;
      if (requestingOrigin !== origin) return false;
      const capability = permission === 'media' ? details.mediaType : permission;
      return Boolean(capability && tab.grants.has(origin + ':' + capability));
    });
    projectSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const tab = [...this.tabs.values()].find((value) => value.contents === contents);
      const media = 'mediaTypes' in details ? details.mediaTypes : undefined;
      const capabilities =
        permission === 'media' ? media : permission === 'geolocation' ? ['geolocation'] : undefined;
      if (
        !tab ||
        this.closed ||
        this.activeTabId !== tab.state.id ||
        !details.isMainFrame ||
        !capabilities?.length
      )
        return callback(false);
      let origin: string;
      try {
        origin = new URL(browserUrl(details.requestingUrl)).origin;
      } catch {
        return callback(false);
      }
      if (origin !== new URL(tab.state.url).origin) return callback(false);
      if (capabilities.every((capability) => tab.grants.has(origin + ':' + capability)))
        return callback(true);
      const epoch = tab.navigationEpoch;
      void dialog
        .showMessageBox(this.window, {
          type: 'question',
          message: 'Allow website permission?',
          detail:
            origin +
            ' requests ' +
            capabilities
              .map((value) =>
                value === 'video' ? 'camera' : value === 'audio' ? 'microphone' : value,
              )
              .join(', ') +
            '. Permission lasts only in this tab until leaving this origin.',
          buttons: ['Allow', 'Deny'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        .then((result) => {
          const allowed =
            result.response === 0 &&
            !this.closed &&
            !contents.isDestroyed() &&
            this.tabs.get(tab.state.id) === tab &&
            tab.navigationEpoch === epoch;
          if (allowed)
            for (const capability of capabilities) tab.grants.add(origin + ':' + capability);
          callback(allowed);
        })
        .catch(() => callback(false));
    });
  }

  async clearProjectProfile(projectId: string) {
    await this.finishComment();
    const tabs = [...this.tabs.values()].filter((tab) => tab.state.projectId === projectId);
    const saved = tabs.map((tab) => ({ ...tab.state }));
    for (const tab of tabs) {
      if (await this.closeTab(tab)) return { cancelled: true, tabs: saved };
    }
    const profile = session.fromPartition(browserPartition(projectId, this.profileData));
    for (const [item, owner] of this.downloadItems) if (owner === projectId) item.cancel();
    await profile.clearStorageData();
    await profile.clearCache();
    return { cancelled: false, tabs: saved };
  }

  private unregisterTab(tab: InternalTab) {
    if (this.tabs.get(tab.state.id) !== tab) return;
    tab.grants.clear();
    this.tabs.delete(tab.state.id);
    this.pendingEditorFocus.delete(tab.state.id);
    this.detachTab(tab);
    for (const [id, binding] of this.visibleViews ?? [])
      if (binding.tabId === tab.state.id) this.visibleViews!.delete(id);
    ++this.layoutGeneration;
    ++tab.navigationEpoch;
    if (this.activeTabId === tab.state.id) {
      this.activeTabId = null;
      this.clearMarkers();
    }
    if (this.tool?.tabId === tab.state.id || this.capture?.tabId === tab.state.id) {
      ++this.captureGeneration;
      this.hideOverlay();
    }
    if (!this.closed) this.hooks.onChange();
  }

  private closeTab(tab: InternalTab): Promise<boolean> {
    const pending = this.closeOperations.get(tab.state.id);
    if (pending) return pending;
    const operation = new Promise<boolean>((resolve, reject) => {
      const contents = tab.contents;
      if (contents.isDestroyed()) {
        this.unregisterTab(tab);
        resolve(false);
        return;
      }
      let settled = false;
      let prompting = false;
      const cleanup = () => {
        clearTimeout(timer);
        contents.removeListener('destroyed', destroyed);
        contents.removeListener('will-prevent-unload', preventUnload);
      };
      const finish = (cancelled: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(cancelled);
      };
      const destroyed = () => finish(false);
      const preventUnload = (event: Electron.Event) => {
        if (prompting) return;
        prompting = true;
        try {
          // Electron's veto override must occur before this event returns.
          const response = dialog.showMessageBoxSync(this.window, {
            type: 'question',
            message: 'Close this tab?',
            detail: 'This page reports unsaved changes. Closing may discard them.',
            buttons: ['Close tab', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          });
          if (response === 0) event.preventDefault();
          else finish(true);
        } catch (error) {
          settled = true;
          cleanup();
          reject(error);
        }
      };
      // A loading/hung renderer must not leave the shell transition locked forever.
      const timer = setTimeout(() => finish(!contents.isDestroyed()), 15_000);
      contents.once('destroyed', destroyed);
      contents.on('will-prevent-unload', preventUnload);
      contents.close({ waitForBeforeUnload: true });
    });
    this.closeOperations.set(tab.state.id, operation);
    void operation.finally(() => this.closeOperations.delete(tab.state.id)).catch(() => {});
    return operation;
  }

  async finishComment() {
    if (this.closed) throw new Error('BROWSER_CLOSED');
    if (this.capture && !this.capture.readonly) {
      const contents = this.overlayContents;
      if (!contents || contents.isDestroyed()) throw new Error('COMMENT_EDITOR_UNAVAILABLE');
      await contents.executeJavaScript('window.projectorFinishComment()');
      await this.operationChain;
    } else if (this.tool || this.capture?.readonly) {
      this.hideOverlay();
    }
  }

  private checkSelection(tabId: string | null) {
    if (this.tool && this.activeTabId !== tabId) this.hideOverlay();
    if (this.capture && !this.capture.readonly && this.activeTabId !== tabId)
      throw new Error('UNFINISHED_COMMENT: Save or cancel the area annotation first.');
    if (tabId !== null && !this.tabs.has(tabId)) throw new Error('BROWSER_TAB_NOT_FOUND');
  }

  private attachTab(tab: InternalTab) {
    if (!this.attachedTabs.has(tab.state.id)) {
      this.window.contentView.addChildView(tab.view);
      this.attachedTabs.add(tab.state.id);
    }
    tab.view.setVisible(!this.resizing);
  }

  private detachTab(tab: InternalTab) {
    if (!this.attachedTabs.delete(tab.state.id)) return;
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
  }

  private viewFocused(tab: InternalTab, event?: Electron.Event) {
    if (this.closed || this.resizing || !this.visibleViews || this.activeTabId === tab.state.id)
      return false;
    const binding = [...this.visibleViews.values()].find((value) => value.tabId === tab.state.id);
    if (!binding || !binding.bounds.width || !binding.bounds.height) return false;
    const browserEditor = this.capture && !this.capture.readonly;
    const blocked = Boolean(browserEditor || this.hooks.hasUnfinishedEditor?.() ||
      this.pendingEditorFocus.has(tab.state.id));
    if (blocked) {
      // Suppress the original gesture until the shell confirms pane activation.
      // Replaying it would act on an external page after a delayed private write.
      this.pendingEditorFocus.add(tab.state.id);
      event?.preventDefault();
      if (browserEditor) this.overlayContents?.focus();
      else this.window.webContents.focus();
    }
    if (this.focusRequest === binding.viewId) return blocked;
    this.focusRequest = binding.viewId;
    const notify = this.hooks.onViewFocus
      ? () => this.hooks.onViewFocus!({ viewId: binding.viewId, tabId: binding.tabId })
      : async () => {
          await this.finishComment();
          this.select(tab.state.id);
        };
    void Promise.resolve()
      .then(notify)
      .catch((error: unknown) => {
        if (!this.closed && this.tabs.get(tab.state.id) === tab) {
          tab.state.error = String(error);
          this.hooks.onChange();
        }
      })
      .finally(() => {
        if (this.focusRequest === binding.viewId) this.focusRequest = null;
      });
    return blocked;
  }

  select(tabId: string | null) {
    this.checkSelection(tabId);
    if (!this.visibleViews)
      for (const id of [...this.attachedTabs]) {
        const tab = this.tabs.get(id);
        if (tab) this.detachTab(tab);
      }
    this.activeTabId = tabId;
    if (tabId) this.pendingEditorFocus.delete(tabId);
    this.focusRequest = null;
    ++this.layoutGeneration;
    this.clearMarkers();
    if (this.visibleViews) {
      const binding = [...this.visibleViews.values()].find((value) => value.tabId === tabId);
      for (const value of this.visibleViews.values()) value.active = value === binding;
      this.bounds = binding?.bounds ?? this.nonBrowserBounds ?? { x: 0, y: 0, width: 0, height: 0 };
      this.overlay?.setBounds(this.bounds);
    } else if (tabId) {
      const tab = this.tabs.get(tabId)!;
      this.attachTab(tab);
      tab.view.setBounds(this.bounds);
    }
    if (this.capture?.readonly) this.hideOverlay();
    this.hooks.onChange();
  }

  setVisibleViews(bindings: readonly BrowserViewBinding[]) {
    if (this.closed) return;
    const [width, height] = this.window.getContentSize();
    const next = new Map<string, BrowserViewBinding>();
    const tabIds = new Set<string>();
    let active: BrowserViewBinding | undefined;
    for (const value of bindings) {
      if (!value.viewId || next.has(value.viewId) || tabIds.has(value.tabId))
        throw new Error('INVALID_BROWSER_VIEWS: Each pane and browser tab must be unique.');
      if (!this.tabs.has(value.tabId)) throw new Error('BROWSER_TAB_NOT_FOUND');
      if (value.active && active)
        throw new Error('INVALID_BROWSER_VIEWS: Only one browser pane can be active.');
      const binding = { ...value, bounds: safeBrowserBounds(value.bounds, { width, height }) };
      next.set(binding.viewId, binding);
      tabIds.add(binding.tabId);
      if (binding.active) active = binding;
    }
    const tabId = active?.tabId ?? null;
    this.checkSelection(tabId);
    const activeChanged = tabId !== this.activeTabId;
    const nextBounds = active?.bounds ?? this.nonBrowserBounds ?? { x: 0, y: 0, width: 0, height: 0 };
    const geometryChanged =
      this.bounds.x !== nextBounds.x ||
      this.bounds.y !== nextBounds.y ||
      this.bounds.width !== nextBounds.width ||
      this.bounds.height !== nextBounds.height;
    if (activeChanged || geometryChanged) {
      ++this.layoutGeneration;
      this.clearMarkers();
      if (this.tool) this.hideOverlay();
      if (this.capture?.readonly && activeChanged) this.hideOverlay();
    }
    this.visibleViews = next;
    this.activeTabId = tabId;
    if (tabId) this.pendingEditorFocus.delete(tabId);
    this.bounds = nextBounds;
    if (activeChanged) this.focusRequest = null;
    for (const id of [...this.attachedTabs]) {
      if (tabIds.has(id)) continue;
      const tab = this.tabs.get(id);
      if (tab) this.detachTab(tab);
    }
    for (const binding of next.values()) {
      const tab = this.tabs.get(binding.tabId)!;
      tab.view.setBounds(binding.bounds);
      this.attachTab(tab);
      tab.view.setVisible(!this.resizing && binding.bounds.width > 0 && binding.bounds.height > 0);
    }
    this.overlay?.setBounds(this.bounds);
    // Newly attached browser panes must not cover an existing trusted editor.
    if ((this.tool || this.capture) && this.overlay)
      this.window.contentView.addChildView(this.overlay);
    if (activeChanged) this.hooks.onChange();
  }

  setResizeMode(active: boolean) {
    // Native views sit above renderer DOM; temporarily hide them without changing
    // tab selection, capture ownership, or an unfinished annotation editor.
    this.resizing = active;
    for (const tab of this.tabs.values()) {
      const binding =
        this.visibleViews &&
        [...this.visibleViews.values()].find((value) => value.tabId === tab.state.id);
      tab.view.setVisible(
        !active && (!binding || (binding.bounds.width > 0 && binding.bounds.height > 0)),
      );
    }
    this.overlay?.setVisible(!active);
    for (const marker of this.markerViews.values()) marker.view.setVisible(!active);
  }

  setBounds(bounds: AreaRect) {
    // Active native panes own their geometry. When a document owns focus, its
    // separately measured surface hosts saved captures and survives empty browser layouts.
    if (this.visibleViews && this.activeTabId) return;
    const [width, height] = this.window.getContentSize();
    ++this.layoutGeneration;
    this.clearMarkers();
    this.bounds = safeBrowserBounds(bounds, { width, height });
    if (this.visibleViews) this.nonBrowserBounds = this.bounds;
    if (this.activeTabId) this.tabs.get(this.activeTabId)?.view.setBounds(this.bounds);
    this.overlay?.setBounds(this.bounds);
  }

  async command(args: {
    tabId: string;
    action:
      | 'back'
      | 'forward'
      | 'reload'
      | 'stop'
      | 'zoom'
      | 'zoom-reset'
      | 'external'
      | 'navigate'
      | 'close'
      | 'annotate';
    zoomFactor?: number;
    url?: string;
  }) {
    const tab = this.tabs.get(args.tabId);
    if (!tab) throw new Error('BROWSER_TAB_NOT_FOUND');
    if (this.tool?.tabId === args.tabId && args.action === 'annotate') {
      this.hideOverlay();
      return this.snapshot();
    }
    if (args.action === 'close' && this.capture && !this.capture.readonly)
      await this.finishComment();
    if (this.tool && args.action !== 'close') this.hideOverlay();
    if (this.capture && !this.capture.readonly)
      throw new Error('UNFINISHED_COMMENT: Save or cancel the area annotation first.');
    const contents = tab.contents;
    if (contents.isDestroyed()) throw new Error('BROWSER_TAB_NOT_FOUND');
    switch (args.action) {
      case 'back':
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        break;
      case 'forward':
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        break;
      case 'reload':
        contents.reload();
        break;
      case 'stop':
        contents.stop();
        break;
      case 'zoom': {
        const factor = args.zoomFactor;
        if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0.5 || factor > 2)
          throw new Error('INVALID_ZOOM: Choose a scale between 50% and 200%.');
        contents.setZoomFactor(factor);
        tab.state.zoomFactor = contents.getZoomFactor();
        break;
      }
      case 'zoom-reset':
        contents.setZoomFactor(1);
        tab.state.zoomFactor = 1;
        break;
      case 'external':
        await shell.openExternal(browserUrl(contents.getURL()));
        break;
      case 'navigate':
        tab.downloadNavigation = browserUrl(args.url ?? '');
        try {
          await contents.loadURL(tab.downloadNavigation);
        } catch (error) {
          if (!isAbortedNavigation(error)) throw error;
        }
        break;
      case 'close': {
        const cancelled = await this.closeTab(tab);
        return { ...this.snapshot(), cancelled };
      }
      case 'annotate':
        await this.beginArea(args.tabId);
        break;
      default:
        throw new Error('UNSUPPORTED_BROWSER_ACTION');
    }
    this.hooks.onChange();
    return this.snapshot();
  }

  private async ensureOverlay() {
    if (this.closed) throw new Error('BROWSER_CLOSED');
    if (!this.overlay) {
      this.overlay = new WebContentsView({
        webPreferences: {
          preload: this.hooks.overlayPreload,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
        },
      });
      this.overlayContents = this.overlay.webContents;
      const overlay = this.overlay,
        contents = this.overlayContents;
      contents.once('destroyed', () => {
        if (this.overlayContents !== contents) return;
        if (!this.window.isDestroyed()) this.window.contentView.removeChildView(overlay);
        this.overlay = null;
        this.overlayContents = null;
        this.overlayReady = null;
        ++this.captureGeneration;
        this.tool = null;
        // Keep the private capture recoverable if its trusted renderer died.
        if (!this.closed) this.hooks.onChange();
      });
      this.overlayContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.overlayContents.on('will-navigate', (event) => event.preventDefault());
      this.overlayReady = this.overlayContents.loadURL(
        'data:text/html;base64,' + Buffer.from(browserOverlayHtml).toString('base64'),
      );
    }
    await this.overlayReady;
    if (this.closed || !this.overlay || !this.overlayContents || this.overlayContents.isDestroyed())
      throw new Error('BROWSER_CLOSED');
    return this.overlay;
  }

  private async probe(
    tab: InternalTab,
  ): Promise<PageProbe & { pageId: string; stateHash: string; layoutHash: string }> {
    const anchors = tab.annotations
      .filter((a) => a.capture?.source.elementAnchor)
      .map((a) => ({ id: a.id, path: a.capture!.source.elementAnchor!.path }));
    const result = (await tab.contents.executeJavaScriptInIsolatedWorld(902, [
      {
        code: `(()=>{
      ${visibleElementRectScript}
      const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
      const resolve=path=>{let el=document.documentElement;for(const i of path){el=el?.children[i];if(!el)return null}return el};
      let state;try{state=JSON.parse(JSON.stringify(history.state))}catch{state={unserializable:true}}
      const layout=[...document.body.querySelectorAll('*')].filter(el=>!['SCRIPT','STYLE','LINK'].includes(el.tagName)).map(el=>{
        const r=rect(el);
        return [el.tagName,Math.round((r.x+scrollX)*10),Math.round((r.y+scrollY)*10),Math.round(r.width*10),Math.round(r.height*10)];
      });
      const anchors=${JSON.stringify(anchors)}.map(a=>{const el=resolve(a.path);return {id:a.id,rect:el?visibleRect(el):null,bounds:el?rect(el):null,text:el?.textContent||'',tag:el?.tagName||'',elementId:el?.id||undefined}});
      const forms=[...document.querySelectorAll('input,select,textarea')].map(el=>[el.tagName,el.type,el.type==='password'?'':el.value,el.checked]);
      return {url:location.href,title:document.title,scroll:{x:scrollX,y:scrollY},history:state,navigationKey:window.navigation?.currentEntry?.key||null,semantic:document.body.outerHTML+JSON.stringify(forms),layout,viewport:{width:innerWidth,height:innerHeight},anchors};
    })()`,
      },
    ])) as PageProbe;
    if (this.closed || tab.contents.isDestroyed() || this.tabs.get(tab.state.id) !== tab)
      throw new Error('BROWSER_CLOSED');
    const index = tab.contents.navigationHistory.getActiveIndex();
    if (!tab.entries.has(index)) tab.entries.set(index, randomUUID());
    const pageId = tab.documentId + ':' + (result.navigationKey ?? tab.entries.get(index)!);
    const stateHash = browserStateHash({
      url: result.url,
      history: result.history,
      semantic: result.semantic,
    });
    const layoutHash = browserStateHash(result.layout);
    const changed = tab.state.pageId !== pageId || tab.state.stateHash !== stateHash;
    tab.state.pageId = pageId;
    tab.state.stateHash = stateHash;
    if (changed) this.hooks.onChange();
    return { ...result, pageId, stateHash, layoutHash };
  }

  private async elementAt(tab: InternalTab, point: { x: number; y: number }) {
    const zoom = tab.contents.getZoomFactor();
    const result = (await tab.contents.executeJavaScriptInIsolatedWorld(902, [
      {
        code: `(()=>{
      ${visibleElementRectScript}
      const el=document.elementFromPoint(${point.x / zoom},${point.y / zoom});if(!el)return null;
      let cursor=el;const path=[];while(cursor!==document.documentElement&&cursor.parentElement){path.unshift([...cursor.parentElement.children].indexOf(cursor));cursor=cursor.parentElement}
      const rect=visibleRect(el);if(!rect)return null;
      const bounds=el.getBoundingClientRect();
      return {rect,bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},path,tag:el.tagName,id:el.id||undefined,text:el.textContent||''};
    })()`,
      },
    ])) as {
      rect: AreaRect;
      bounds: AreaRect;
      path: number[];
      tag: string;
      id?: string;
      text: string;
    } | null;
    if (!result) return null;
    const x = Math.max(0, result.rect.x * zoom),
      y = Math.max(0, result.rect.y * zoom);
    const rect = {
      x,
      y,
      width: Math.max(
        0,
        Math.min(this.bounds.width, (result.rect.x + result.rect.width) * zoom) - x,
      ),
      height: Math.max(
        0,
        Math.min(this.bounds.height, (result.rect.y + result.rect.height) * zoom) - y,
      ),
    };
    return {
      rect,
      elementAnchor: {
        path: result.path,
        tag: result.tag,
        ...(result.id ? { id: result.id } : {}),
        textHash: browserStateHash(result.text),
        pointerOffset: { x: point.x / zoom - result.bounds.x, y: point.y / zoom - result.bounds.y },
      },
    };
  }

  // Compare the visible selected region, not the whole page: clocks, offscreen counters,
  // and unrelated reactive attributes must not make a stable selection impossible.
  private async captureRegionHash(tab: InternalTab, area: AreaRect, zoom: number) {
    const region = {
      x: area.x / zoom,
      y: area.y / zoom,
      width: area.width / zoom,
      height: area.height / zoom,
    };
    const value = await tab.contents.executeJavaScriptInIsolatedWorld(902, [
      {
        code: `(()=>{
      ${visibleElementRectScript}
      const region=${JSON.stringify(region)};
      return [...document.body.querySelectorAll('*'),document.body].flatMap(el=>{
        if(['SCRIPT','STYLE','LINK','META'].includes(el.tagName))return [];
        const rect=visibleRect(el);
        if(!rect||rect.x>=region.x+region.width||rect.y>=region.y+region.height||rect.x+rect.width<=region.x||rect.y+rect.height<=region.y)return [];
        const css=getComputedStyle(el);
        const text=[...el.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join('');
        const form=['INPUT','SELECT','TEXTAREA'].includes(el.tagName)?[el.type,el.type==='password'?'':el.value,el.checked]:null;
        return [[el.tagName,el.id,rect,text,form,css.color,css.backgroundColor,css.opacity,css.font,css.transform,el.getAttribute('src')]];
      });
    })()`,
      },
    ]);
    return browserStateHash(value);
  }

  async beginArea(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error('BROWSER_TAB_NOT_FOUND');
    this.select(tabId);
    if (this.bounds.width < 1 || this.bounds.height < 1) throw new Error('BROWSER_NOT_VISIBLE');
    tab.state.error = null;
    const generation = ++this.captureGeneration;
    const revisionId = await this.hooks.getRevision?.(tab.state.artifactId);
    if (this.activeTabId !== tabId || generation !== this.captureGeneration)
      throw new Error('CAPTURE_CHANGED: Browser selection changed before activation.');
    this.capture = null;
    this.tool = { tabId, revisionId: revisionId ?? null };
    this.clearMarkers();
    const overlay = await this.ensureOverlay();
    if (!this.tool || this.activeTabId !== tabId || generation !== this.captureGeneration)
      throw new Error('CAPTURE_CHANGED: Browser selection changed before activation.');
    overlay.setBackgroundColor('#00000000');
    overlay.setBounds(this.bounds);
    this.window.contentView.addChildView(overlay);
    this.overlayContents!.send('projector:browser-overlay-load', {
      mode: 'live',
      viewport: { width: this.bounds.width, height: this.bounds.height },
    });
    this.overlayContents!.focus();
    this.hooks.onChange();
    return { mode: 'live' };
  }

  private async captureSelection(value: unknown) {
    const generation = this.captureGeneration;
    const tab = this.tool && this.tabs.get(this.tool.tabId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const draft = await Promise.race([
        this.captureSelectionWithinDeadline(value),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (generation === this.captureGeneration) {
              if (tab) tab.state.error = 'Capture timed out. Select Annotate and try again.';
              ++this.captureGeneration;
              this.hideOverlay();
            }
            reject(new CaptureChangedError('Capture timed out.'));
          }, runtimeLimits().captureTimeoutMs);
        }),
      ]);
      // The capture deadline ends before beginning an acknowledged private write.
      // Timing out an in-flight write would create an unknown-result/late-clear race.
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (generation !== this.captureGeneration || this.closed)
        throw new CaptureChangedError('Capture was cancelled.');
      this.tool = null;
      this.capture = draft;
      await this.hooks.onDraft?.({ ...draft });
      if (generation !== this.captureGeneration || this.closed)
        throw new CaptureChangedError('Capture was cancelled.');
      await this.showOverlay();
      this.hooks.onChange();
      return { captureId: draft.capture.id };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async captureSelectionWithinDeadline(value: unknown) {
    if (!this.tool) throw new Error('ANNOTATE_TOOL_NOT_ACTIVE');
    const input = overlaySelectionSchema.parse(value);
    const tool = this.tool,
      tab = this.tabs.get(tool.tabId);
    if (!tab) throw new Error('BROWSER_TAB_NOT_FOUND');
    const generation = this.captureGeneration;
    const navigationEpoch = tab.navigationEpoch;
    const viewport = { width: this.bounds.width, height: this.bounds.height };
    const zoomFactor = tab.contents.getZoomFactor();
    let capture: BrowserCapture | undefined;
    let initialTarget: BrowserElementAnchor | undefined;
    if (
      input.point.x < 0 ||
      input.point.y < 0 ||
      input.point.x > viewport.width ||
      input.point.y > viewport.height
    )
      throw new Error('INVALID_POINTER');
    // Retry changes within the selection. Unrelated page activity is allowed; the frozen
    // viewport PNG remains the reference even if the live page continues updating.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.probe(tab);
      const selected = input.rect
        ? { rect: validateArea(input.rect, this.bounds) }
        : await this.elementAt(tab, input.point);
      if (!selected || selected.rect.width < 1 || selected.rect.height < 1)
        throw new Error('EMPTY_SELECTION');
      if ('elementAnchor' in selected) {
        const target = selected.elementAnchor;
        if (
          initialTarget &&
          (initialTarget.tag !== target.tag ||
            initialTarget.id !== target.id ||
            JSON.stringify(initialTarget.path) !== JSON.stringify(target.path))
        )
          throw new CaptureChangedError('The selected element changed.');
        initialTarget ??= target;
      }
      const regionBefore = await this.captureRegionHash(tab, selected.rect, zoomFactor);
      const image = await tab.contents.capturePage();
      const after = await this.probe(tab);
      if (
        this.closed ||
        tab.contents.isDestroyed() ||
        this.tabs.get(tab.state.id) !== tab ||
        generation !== this.captureGeneration ||
        this.tool !== tool ||
        tab.navigationEpoch !== navigationEpoch ||
        before.pageId !== after.pageId ||
        viewport.width !== this.bounds.width ||
        viewport.height !== this.bounds.height ||
        zoomFactor !== tab.contents.getZoomFactor() ||
        before.viewport.width !== after.viewport.width ||
        before.viewport.height !== after.viewport.height ||
        before.scroll.x !== after.scroll.x ||
        before.scroll.y !== after.scroll.y
      )
        throw new CaptureChangedError('The page, viewport or scroll position changed.');
      const selectedAfter = input.rect ? null : await this.elementAt(tab, input.point);
      if (
        initialTarget &&
        (!selectedAfter ||
          selectedAfter.elementAnchor.tag !== initialTarget.tag ||
          selectedAfter.elementAnchor.id !== initialTarget.id ||
          JSON.stringify(selectedAfter.elementAnchor.path) !== JSON.stringify(initialTarget.path))
      )
        throw new CaptureChangedError('The selected element changed.');
      if (selectedAfter && JSON.stringify(selectedAfter.rect) !== JSON.stringify(selected.rect))
        continue;
      if (
        'elementAnchor' in selected &&
        selectedAfter &&
        selectedAfter.elementAnchor.textHash !== selected.elementAnchor.textHash
      )
        continue;
      const regionAfter = await this.captureRegionHash(tab, selected.rect, zoomFactor);
      if (regionBefore !== regionAfter) continue;
      const display = screen.getDisplayMatching(this.window.getBounds());
      capture = {
        id: randomUUID(),
        png: image.toPNG().toString('base64'),
        source: {
          kind: 'browser-area',
          url: browserUrl(after.url),
          title: after.title,
          capturedAt: new Date().toISOString(),
          viewport: {
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: display.scaleFactor,
          },
          rect: selected.rect,
          pointer: input.point,
          zoomFactor,
          scroll: after.scroll,
          pageId: after.pageId,
          stateHash: before.stateHash,
          layoutHash: before.layoutHash,
          ...('elementAnchor' in selected ? { elementAnchor: selected.elementAnchor } : {}),
        },
      };
      break;
    }
    if (!capture) throw new CaptureChangedError('The page is still updating.');
    if (generation !== this.captureGeneration || this.closed)
      throw new CaptureChangedError('Capture was cancelled.');
    return {
      artifactId: tab.state.artifactId,
      tabId: tool.tabId,
      revisionId: tool.revisionId,
      capture,
      comment: '',
    };
  }

  setAnnotations(artifactId: string, annotations: BrowserMarkerAnnotation[]) {
    for (const tab of this.tabs.values())
      if (tab.state.artifactId === artifactId) tab.annotations = annotations;
    void this.refreshMarkers().catch(() => {});
  }

  async refreshAnnotations() {
    for (const tab of this.tabs.values())
      if (this.hooks.getAnnotations)
        tab.annotations = await this.hooks.getAnnotations(tab.state.artifactId);
    await this.refreshMarkers();
  }

  private clearMarkers() {
    for (const marker of this.markerViews.values()) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(marker.view);
      if (!marker.contents.isDestroyed()) marker.contents.close();
    }
    this.markerViews.clear();
  }

  private async refreshMarkers() {
    if (
      this.closed ||
      this.resizing ||
      this.markerBusy ||
      !this.activeTabId ||
      this.tool ||
      this.capture
    )
      return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab || tab.contents.isDestroyed()) return;
    if (tab.contents.isLoading()) {
      this.clearMarkers();
      return;
    }
    const navigationEpoch = tab.navigationEpoch;
    const layoutGeneration = this.layoutGeneration;
    if (!tab.annotations.length) {
      this.clearMarkers();
      return;
    }
    this.markerBusy = true;
    try {
      const probe = await this.probe(tab),
        zoom = tab.contents.getZoomFactor(),
        visible = new Set<string>();
      if (
        this.closed ||
        tab.contents.isDestroyed() ||
        this.tabs.get(tab.state.id) !== tab ||
        this.tool ||
        this.capture ||
        this.resizing ||
        this.activeTabId !== tab.state.id ||
        this.layoutGeneration !== layoutGeneration ||
        tab.navigationEpoch !== navigationEpoch ||
        tab.contents.isLoading()
      )
        return;
      for (const annotation of tab.annotations) {
        const source = annotation.capture?.source;
        if (!source || source.pageId !== probe.pageId || source.stateHash !== probe.stateHash)
          continue;
        let rect: AreaRect;
        let pointer: { x: number; y: number } | undefined;
        if (source.elementAnchor) {
          const anchor = probe.anchors.find((a) => a.id === annotation.id),
            expected = source.elementAnchor;
          if (
            !anchor?.rect ||
            anchor.tag !== expected.tag ||
            anchor.elementId !== expected.id ||
            browserStateHash(anchor.text) !== expected.textHash
          )
            continue;
          rect = {
            x: anchor.rect.x * zoom,
            y: anchor.rect.y * zoom,
            width: anchor.rect.width * zoom,
            height: anchor.rect.height * zoom,
          };
          if (source.pointer && expected.pointerOffset && anchor.bounds)
            pointer = {
              x: (anchor.bounds.x + expected.pointerOffset.x) * zoom,
              y: (anchor.bounds.y + expected.pointerOffset.y) * zoom,
            };
        } else {
          if (!source.rect || !source.layoutHash || source.layoutHash !== probe.layoutHash)
            continue;
          rect = {
            x: (source.rect.x / source.zoomFactor + source.scroll.x - probe.scroll.x) * zoom,
            y: (source.rect.y / source.zoomFactor + source.scroll.y - probe.scroll.y) * zoom,
            width: (source.rect.width / source.zoomFactor) * zoom,
            height: (source.rect.height / source.zoomFactor) * zoom,
          };
          if (source.pointer)
            pointer = {
              x: (source.pointer.x / source.zoomFactor + source.scroll.x - probe.scroll.x) * zoom,
              y: (source.pointer.y / source.zoomFactor + source.scroll.y - probe.scroll.y) * zoom,
            };
        }
        pointer ??= { x: rect.x + rect.width, y: rect.y };
        if (
          rect.x + rect.width < 0 ||
          rect.y + rect.height < 0 ||
          rect.x > this.bounds.width ||
          rect.y > this.bounds.height
        )
          continue;
        if (
          pointer.x < rect.x ||
          pointer.y < rect.y ||
          pointer.x > rect.x + rect.width ||
          pointer.y > rect.y + rect.height ||
          pointer.x < 0 ||
          pointer.y < 0 ||
          pointer.x > this.bounds.width ||
          pointer.y > this.bounds.height
        )
          continue;
        visible.add(annotation.id);
        let marker = this.markerViews.get(annotation.id);
        if (!marker) {
          const view = new WebContentsView({
            webPreferences: {
              preload: this.hooks.overlayPreload,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              webSecurity: true,
            },
          });
          view.setBackgroundColor('#00000000');
          view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
          view.webContents.on('will-navigate', (e) => e.preventDefault());
          marker = {
            view,
            contents: view.webContents,
            artifactId: tab.state.artifactId,
            annotationId: annotation.id,
          };
          this.markerViews.set(annotation.id, marker);
          const created = marker;
          marker.contents.once('destroyed', () => {
            if (this.markerViews.get(annotation.id) !== created) return;
            this.markerViews.delete(annotation.id);
            if (!this.window.isDestroyed()) this.window.contentView.removeChildView(created.view);
          });
          await marker.contents.loadURL(
            'data:text/html;base64,' + Buffer.from(browserMarkerHtml).toString('base64'),
          );
          if (
            this.closed ||
            tab.contents.isDestroyed() ||
            this.tabs.get(tab.state.id) !== tab ||
            this.tool ||
            this.capture ||
            this.resizing ||
            this.activeTabId !== tab.state.id ||
            this.layoutGeneration !== layoutGeneration ||
            tab.navigationEpoch !== navigationEpoch ||
            tab.contents.isLoading()
          ) {
            this.clearMarkers();
            return;
          }
          this.window.contentView.addChildView(view);
        }
        const { cx, cy } = markerGeometry(pointer, this.bounds);
        const left = Math.max(0, Math.floor(Math.min(pointer.x, cx - 14))),
          top = Math.max(0, Math.floor(Math.min(pointer.y, cy - 14)));
        const width = Math.ceil(Math.max(pointer.x, cx + 14) - left),
          height = Math.ceil(Math.max(pointer.y, cy + 14) - top);
        marker.view.setBounds({ x: this.bounds.x + left, y: this.bounds.y + top, width, height });
        marker.contents.send('projector:browser-overlay-load', {
          number: annotation.number,
          pointer: { x: pointer.x - left, y: pointer.y - top },
          center: { x: cx - left, y: cy - top },
        });
      }
      for (const [id, marker] of this.markerViews)
        if (!visible.has(id)) {
          this.window.contentView.removeChildView(marker.view);
          if (!marker.contents.isDestroyed()) marker.contents.close();
          this.markerViews.delete(id);
        }
    } finally {
      this.markerBusy = false;
    }
  }

  async restoreDraft(
    value: CaptureDraft & { artifactId: string; tabId: string; revisionId?: string | null },
  ) {
    if (this.capture && !this.capture.readonly) throw new Error('UNFINISHED_COMMENT');
    if (this.tool) this.hideOverlay();
    this.capture = value;
    await this.showOverlay();
    this.hooks.onChange();
  }

  async showCapture(value: CaptureDraft & { artifactId: string; tabId?: string; number?: number }) {
    if (this.capture && !this.capture.readonly) throw new Error('UNFINISHED_COMMENT');
    if (this.tool) this.hideOverlay();
    this.capture = { ...value, tabId: value.tabId ?? '', readonly: true };
    await this.showOverlay();
    this.hooks.onChange();
  }

  private async showOverlay() {
    const overlay = await this.ensureOverlay();
    if (!this.capture || this.closed) return;
    overlay.setBounds(this.bounds);
    this.window.contentView.addChildView(overlay);
    this.overlayContents!.send('projector:browser-overlay-load', {
      ...this.capture.capture,
      comment: this.capture.comment,
      readonly: Boolean(this.capture.readonly),
      number: this.capture.number,
    });
    this.overlayContents!.focus();
  }

  private hideOverlay() {
    ++this.captureGeneration;
    if (this.overlay && !this.window.isDestroyed())
      this.window.contentView.removeChildView(this.overlay);
    this.capture = null;
    this.tool = null;
    this.hooks.onChange();
  }

  private async overlayAction(action: unknown, value: unknown, generation: number) {
    if (action === 'hover' || action === 'select' || action === 'wheel') {
      const input = action === 'select'
        ? overlaySelectionSchema.parse(value).point
        : overlayPointerSchema.parse(value);
      // Live pointer traffic can already be queued when navigation hides the
      // overlay. It cannot act on a later tool or on an unrelated saved capture.
      if (!this.tool || this.closed || generation !== this.captureGeneration)
        throw new CaptureChangedError('The annotation tool was closed.');
      if (input.x < 0 || input.y < 0 || input.x > this.bounds.width || input.y > this.bounds.height)
        throw new Error('INVALID_POINTER');
      const tab = this.tabs.get(this.tool.tabId);
      if (!tab) throw new Error('BROWSER_TAB_NOT_FOUND');
      if (action === 'select') return this.captureSelection(value);
      const point = overlayPointerSchema.parse(value);
      if (action === 'wheel') {
        tab.contents.sendInputEvent({
          type: 'mouseWheel',
          x: Math.round(point.x),
          y: Math.round(point.y),
          deltaX: point.deltaX ?? 0,
          deltaY: point.deltaY ?? 0,
        });
        return { scrolled: true };
      }
      const hit = await this.elementAt(tab, point);
      if (!this.tool || this.closed || generation !== this.captureGeneration)
        throw new CaptureChangedError('The annotation tool was closed.');
      return hit;
    }
    if (this.tool && action === 'cancel') {
      this.hideOverlay();
      return { cancelled: true };
    }
    if (!this.capture) throw new Error('CAPTURE_NOT_FOUND');
    if (action === 'cancel') {
      const editable = !this.capture.readonly;
      this.hideOverlay();
      // The runtime may release a queued show_artifact when editing becomes false.
      // Remove the native editing surface first so that request can safely switch tabs.
      if (editable) await this.hooks.onDraft?.(null);
      return { cancelled: true };
    }
    if (this.capture.readonly) throw new Error('READ_ONLY_CAPTURE');
    if (action !== 'draft' && action !== 'submit' && action !== 'finish')
      throw new Error('UNSUPPORTED_OVERLAY_ACTION');
    const input = editSchema.parse(value);
    if (input.captureId !== this.capture.capture.id) throw new Error('CAPTURE_MISMATCH');
    if (input.rect) validateArea(input.rect, this.capture.capture.source.viewport);
    this.capture.capture.source.rect = input.rect ?? undefined;
    this.capture.comment = input.comment;
    if (action === 'draft') {
      await this.hooks.onDraft?.({ ...this.capture });
      return { savedPrivately: true };
    }
    if (action === 'finish' && !input.comment.trim()) {
      this.hideOverlay();
      await this.hooks.onDraft?.(null);
      return { cancelled: true };
    }
    if (!input.rect || !input.comment.trim()) throw new Error('EMPTY_ANNOTATION');
    const completed = { ...this.capture };
    const result = await this.hooks.onAnnotation(completed);
    this.hideOverlay();
    try {
      await this.hooks.onDraft?.(null);
    } catch (error) {
      this.capture = completed;
      await this.showOverlay();
      throw error;
    }
    await this.showCapture({ ...completed, number: result.number });
    return result;
  }

  async decorateCapture(
    png: string,
    rect: AreaRect,
    number: number,
    viewport: { width: number; height: number },
    pointer?: { x: number; y: number },
  ) {
    validateArea(rect, viewport);
    if (
      !Number.isInteger(number) ||
      number < 1 ||
      png.length > 40_000_000 ||
      !/^[A-Za-z0-9+/=]+$/.test(png)
    )
      throw new Error('INVALID_CAPTURE');
    await this.ensureOverlay();
    return (await this.overlayContents!.executeJavaScript(
      'window.projectorDraw(' +
        [png, rect, number, viewport, pointer ?? null]
          .map((value) => JSON.stringify(value))
          .join(',') +
        ')',
    )) as string;
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.markerTimer);
    if (this.overlayContents) retiredOverlayContents.add(this.overlayContents);
    for (const marker of this.markerViews.values()) retiredOverlayContents.add(marker.contents);
    this.releaseOverlayHandler();
    if (this.overlay && !this.window.isDestroyed()) this.window.contentView.removeChildView(this.overlay);
    this.clearMarkers();
    ++this.captureGeneration;
    for (const tab of [...this.tabs.values()]) {
      this.detachTab(tab);
      if (!tab.contents.isDestroyed()) tab.contents.close();
    }
    this.tabs.clear();
    this.attachedTabs.clear();
    this.visibleViews?.clear();
    this.focusRequest = null;
    ++this.layoutGeneration;
    this.activeTabId = null;
    this.capture = null;
    this.tool = null;
    for (const item of this.downloadItems.keys()) item.cancel();
    this.downloadItems.clear();
    for (const guard of this.downloadGuards.values()) {
      guard.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      guard.session.setPermissionCheckHandler(() => false);
      guard.session.removeListener('will-download', guard.listener);
    }
    this.downloadGuards.clear();
    if (this.overlayContents && !this.overlayContents.isDestroyed()) this.overlayContents.close();
  }
}
