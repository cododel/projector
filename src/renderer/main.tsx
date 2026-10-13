import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import mermaid from 'mermaid';
import type { DocumentNode, WidgetDefinition } from '../document/types';
import './style.css';
import { Icon } from './Icon';
import { WorkspaceMenu } from './WorkspaceMenu';
import { markerGeometry, commentPosition } from '../shared/annotation-marker';
import { SidebarResizer } from './SidebarResizer';
import { fitSidebars, SIDEBAR_DEFAULT } from '../shared/sidebar-layout';
import { GuideViewer } from './GuideViewer';
import type { GuideResponse } from '../guide';
import { CommentComposer, type CommentComposerHandle } from './CommentComposer';
import type { WorkspaceSnapshot } from '../shared/workspace';
import { captureTextSelection, anchorRange } from './anchors';
import { annotationClip } from './annotation-visibility';
import { RefreshQueue } from './refresh-queue';
import { TerminalPane } from './TerminalPane';
import { SessionActions, ArchiveNotice, type ArchivedChat } from './SessionActions';
import { WorkspaceSplit } from './WorkspaceSplit';
import { ProjectDashboard } from './ProjectDashboard';
import { ApplicationSettings } from './ApplicationSettings';
import {
  PlanDocumentPane,
  BrowserWorkspacePane,
  HomeWorkspacePane,
  type DocumentFrame,
} from './PlanWorkspacePane';
import { shortcutAction } from './shortcuts';
import {
  DEFAULT_SETTINGS,
  paneLeaves,
  type ApplicationWorkspaceSnapshot,
  type ApplicationSettings as Settings,
  type PaneNode,
  type ShortcutAction,
} from '../shared/application-workspace';
import type { TerminalRecord, TerminalOutput } from '../shared/terminal';
import type { HarnessSession, HarnessSnapshot } from '../shared/harness';
interface FullApplicationSnapshot extends ApplicationWorkspaceSnapshot {
  terminals: TerminalRecord[];
  harnesses: HarnessSnapshot;
  metadataPending?: boolean;
}

import {
  canonicalString as canonical,
  type AnnotationStateContext as AnnotationState,
} from '../shared/annotation-context';

type Value = string | string[];
interface Endpoint {
  blockId: string;
  path: number[];
  offset: number;
}
interface TextAnchor {
  start: Endpoint;
  end: Endpoint;
}
interface SelectionData {
  quote: string;
  prefix: string;
  suffix: string;
  blockId: string;
  kind?: 'text' | 'document-area' | 'browser-area';
  anchor?: TextAnchor;
  capture?: Record<string, unknown>;
  stateContext?: AnnotationState;
}
interface Annotation extends SelectionData {
  id: string;
  artifactId: string;
  revisionId: string | null;
  comment: string;
  number?: number;
}
interface Project {
  id: string;
  path: string;
  available?: boolean;
}
interface Artifact {
  id: string;
  projectId: string;
  title: string;
  originSession: { harness: string; sessionId: string } | null;
  latestRevision: string | null;
  displayStatus?: string;
  privateChanges?: boolean;
  archived?: boolean;
  revisions?: ({ id: string } | string)[];
}
interface FeedbackPackage {
  id: string;
  artifactId?: string;
  createdAt: string;
  status?: string;
  notification?: string;
  projectId?: string;
}
interface Snapshot {
  projects: Project[];
  selectedProject?: string | null;
  artifacts: Artifact[];
  selected: { artifactId: string; revisionId: string | null } | null;
  packages: FeedbackPackage[];
  savedStates?: FeedbackPackage[];
  draft?: { annotations?: Annotation[] };
  annotations?: Annotation[];
}
interface DocumentResult {
  migrationSummary?: {
    retained: string[];
    added: string[];
    requiresResponse: string[];
    removed: string[];
  };
  editor?: { selection: SelectionData; comment: string; annotationId?: string } | null;
  revision: { id: string; blocks: DocumentNode[]; widgets: WidgetDefinition[] } | null;
  preview?: { blocks: DocumentNode[]; widgets: WidgetDefinition[] };
  draft?: boolean;
  source?: string;
  error?: string;
  state: { values: Record<string, Value> };
  annotations: Annotation[];
  approved: boolean;
  dirty?: boolean;
  latestSavedStateId?: string | null;
  view?: { details: Record<string, boolean> };
  scrollTop?: number;
  annotationState?: AnnotationState;
}
interface BrowserTab {
  id: string;
  artifactId: string;
  projectId: string;
  url: string;
  title: string;
  loading: boolean;
  error: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
}
interface BrowserSnapshot {
  tabs: BrowserTab[];
  activeTabId: string | null;
  annotating: boolean;
  downloads?: { id: string; tabId: string; filename: string; status: string }[];
}
interface Bridge {
  invoke(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onOperationStatus?(
    callback: (status: { waiting: boolean; operation?: string }) => void,
  ): () => void;
  onRefresh(callback: () => void): (() => void) | void;
  isShuttingDown?(): boolean;
  onShutdown?(callback: () => void): () => void;
  getPathForFile?(file: File): string;
  onTerminalOutput?(callback: (output: TerminalOutput) => void): () => void;
  onOpenSettings?(callback: () => void): () => void;
  onShortcut?(callback: (action: ShortcutAction) => void): () => void;
  onPaneFocus?(callback: (pane: { key: string; paneId: string }) => void): () => void;
}
const isSurface = new URLSearchParams(window.location.search).get('surface') === '1';
function documentShellOrigin(): string {
  const requestedOrigin =
    new URLSearchParams(window.location.search).get('shellOrigin') ?? 'projector://app';
  const originUrl = new URL(requestedOrigin);
  return requestedOrigin === 'projector://app' ||
    (originUrl.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname))
    ? requestedOrigin
    : 'projector://app';
}
function documentBridge(): Bridge {
  const shellOrigin = documentShellOrigin();
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const listeners = new Set<() => void>();
  window.addEventListener('message', (event) => {
    if (
      event.origin !== shellOrigin ||
      event.source !== window.parent ||
      !event.data ||
      typeof event.data !== 'object'
    )
      return;
    const data = event.data as {
      type?: string;
      id?: string;
      result?: unknown;
      error?: string;
      artifactId?: string;
      revisionId?: string | null;
    };
    if (data.type === 'projector-refresh') {
      const identity = new URLSearchParams(window.location.search);
      if (
        data.artifactId !== identity.get('artifactId') ||
        (data.revisionId ?? null) !== (identity.get('revisionId') || null)
      )
        return;
      for (const listener of listeners) listener();
      return;
    }
    if (data.type !== 'projector-response' || typeof data.id !== 'string') return;
    const request = pending.get(data.id);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  });
  return {
    invoke(method, params = {}) {
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Document request timed out.'));
        }, 15000);
        pending.set(id, { resolve, reject, timeout });
        window.parent.postMessage({ type: 'projector-request', id, method, params }, shellOrigin);
      });
    },
    onRefresh(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
}
const bridge = isSurface
  ? documentBridge()
  : (window as unknown as { projector: Bridge }).projector;
async function invoke<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return (await bridge.invoke(method, params)) as T;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
const emptySnapshot: Snapshot = { projects: [], artifacts: [], selected: null, packages: [] };

function annotationSelection(a: Annotation): SelectionData {
  return {
    quote: a.quote,
    prefix: a.prefix ?? '',
    suffix: a.suffix ?? '',
    blockId: a.blockId ?? 'document',
    ...(a.kind ? { kind: a.kind } : {}),
    ...(a.anchor ? { anchor: a.anchor } : {}),
    ...(a.capture ? { capture: a.capture } : {}),
    ...(a.stateContext ? { stateContext: a.stateContext } : {}),
  };
}
function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [projectId, setProjectId] = useState('');
  const [application, setApplication] = useState<FullApplicationSnapshot | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const browserSuspensions = useRef(new Set<string>());
  function suspendBrowser(reason: string, active: boolean): void {
    const before = browserSuspensions.current.size > 0;
    if (active) browserSuspensions.current.add(reason);
    else browserSuspensions.current.delete(reason);
    const after = browserSuspensions.current.size > 0;
    if (before !== after)
      void invoke('browserResizeMode', {active: after}).catch(error => setError(message(error)));
  }
  const workspaceMenuChanged = (label: string, open: boolean) => suspendBrowser(`menu:${label}`, open);
  const sessionChanges = useRef(new Set<string>());
  const [pendingSessions, setPendingSessions] = useState<string[]>([]);
  const [archivedChats, setArchivedChats] = useState<ArchivedChat[]>([]);
  const [sessionMetadata, setSessionMetadata] = useState<HarnessSession | null>(null);
  const [bottomFocused, setBottomFocused] = useState(false);
  const [bottomHeightPreview, setBottomHeightPreview] = useState<number | null>(null);
  const bottomDrag = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    height: number;
  } | null>(null);
  const documentFrames = useRef(new Map<string, DocumentFrame>());
  const browserProjection = useRef<FullApplicationSnapshot | null>(null);
  const editingFrames = useRef(new Set<string>());
  const [documentEditing, setDocumentEditing] = useState(false);
  const nativeFrames = useRef(new Map<string, { nativeId?: string; element: HTMLDivElement }>());
  const [framesVersion, setFramesVersion] = useState(0);
  const currentKey = application?.selectedWorkspace ?? null;
  const sessionWorkspace = currentKey ? application?.workspaces[currentKey] : undefined;
  const projectOverview = application?.selectedSurface === 'project' && sessionWorkspace?.sessionId === null;
  const [showArchivedPlans, setShowArchivedPlans] = useState(false);
  const applicationTab = projectOverview ? undefined : sessionWorkspace?.tabs.find(
    (tab) => tab.id === sessionWorkspace.activeTabId,
  );
  const activePane = applicationTab
    ? paneLeaves(applicationTab.root).find((pane) => pane.id === sessionWorkspace?.activePaneId)
    : undefined;
  const appMode = Boolean(sessionWorkspace);
  const currentSettings = application?.settings ?? DEFAULT_SETTINGS;
  const selectedSession = application?.harnesses.sessions.find(
    (session) => session.id === sessionWorkspace?.sessionId,
  );
  const bottom = application?.bottom[sessionWorkspace?.projectId ?? projectId];
  const registerDocument = useCallback((paneId: string, value: DocumentFrame | null) => {
    const previous = documentFrames.current.get(paneId);
    if (value) documentFrames.current.set(paneId, value);
    else documentFrames.current.delete(paneId);
    if (
      previous &&
      (!value || previous.key !== value.key || previous.revisionId !== value.revisionId)
    ) {
      const scope = `pane:${previous.key}:${previous.paneId}`;
      editingFrames.current.delete(scope);
      setDocumentEditing(editingFrames.current.size > 0);
      void invoke('editing', { active: false, scope }).catch((error) => setError(message(error)));
    }
    setFramesVersion((version) => version + 1);
  }, []);
  const registerBrowser = useCallback(
    (paneId: string, value: { nativeId?: string; element: HTMLDivElement } | null) => {
      if (value) nativeFrames.current.set(paneId, value);
      else nativeFrames.current.delete(paneId);
      setFramesVersion((version) => version + 1);
    },
    [],
  );
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(false);
  useEffect(() => bridge.onOperationStatus?.((value) => setWaiting(value.waiting)), []);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<import('../shared/protocol').McpSetup | null>(null);
  const informationBrowser = useRef<string | null>(null);
  const informationFocus = useRef<HTMLElement | null>(null);
  const revokeIntent = useRef<Record<string, unknown> | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [renaming, setRenaming] = useState<{
    artifactId: string;
    title: string;
    operationId: string;
  } | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState('');
  const creatingSession = useRef(false);
  const renameSubmitting = useRef(false);
  const [runtimeNotice, setRuntimeNotice] = useState(false);
  const guideLoad = useCallback(
    (input: { topic?: string; reference?: string }) => invoke<GuideResponse>('guide', input),
    [],
  );
  useEffect(() => {
    void invoke<{ dismissed: boolean }>('runtimeNotice')
      .then((value) => setRuntimeNotice(!value.dismissed))
      .catch((error) => setError(message(error)));
  }, []);
  const [notification, setNotification] = useState('');
  const [notificationState, setNotificationState] = useState<{
    artifactId: string;
    savedStateId: string;
  } | null>(null);
  const [handoffSessionId, setHandoffSessionId] = useState('');
  const [document, setDocument] = useState<DocumentResult | null>(null);
  const [editing, setEditing] = useState<Annotation | null>(null);
  const [comment, setComment] = useState('');
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [savingCount, setSavingCount] = useState(0);
  const [failedAutosaves, setFailedAutosaves] = useState<Set<string>>(new Set());
  const [documentPreview, setDocumentPreview] = useState(false);
  const [jump, setJump] = useState<Annotation | null>(null);
  const [browser, setBrowser] = useState<BrowserSnapshot>({
    tabs: [],
    activeTabId: null,
    annotating: false,
  });
  const [url, setUrl] = useState('');
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [sidebarPreview, setSidebarPreview] = useState<{
    side: 'left' | 'right';
    width: number;
  } | null>(null);
  const sidebarWrites = useRef(Promise.resolve());
  const [sidebarAnimating, setSidebarAnimating] = useState(false);
  const [sidebarAnimationWidths, setSidebarAnimationWidths] = useState({ left: 250, right: 310 });
  const leftSidebarContent = useRef<HTMLElement>(null);
  const rightSidebarContent = useRef<HTMLElement>(null);
  const sidebarAnimationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (sidebarAnimationTimer.current) clearTimeout(sidebarAnimationTimer.current);
    },
    [],
  );
  function animateSidebars(layout: WorkspaceSnapshot['layout']) {
    const target = fitSidebars(
      layout.leftSidebarVisible ? (layout.leftSidebarWidth ?? SIDEBAR_DEFAULT.left) : 0,
      layout.rightSidebarVisible ? (layout.rightSidebarWidth ?? SIDEBAR_DEFAULT.right) : 0,
      window.innerWidth,
    );
    setSidebarAnimationWidths({
      left: leftSidebarVisible
        ? (leftSidebarContent.current?.getBoundingClientRect().width ?? target.left)
        : target.left,
      right: rightSidebarVisible
        ? (rightSidebarContent.current?.getBoundingClientRect().width ?? target.right)
        : target.right,
    });
    if (sidebarAnimationTimer.current) clearTimeout(sidebarAnimationTimer.current);
    setSidebarAnimating(true);
    sidebarAnimationTimer.current = setTimeout(() => {
      sidebarAnimationTimer.current = null;
      setSidebarAnimating(false);
    }, 250);
  }
  useEffect(() => {
    const update = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>({
    plans: {},
    layout: { leftSidebarVisible: true, rightSidebarVisible: true },
  });
  const leftSidebarVisible =
    sidebarPreview?.side === 'left'
      ? sidebarPreview.width !== 0
      : workspace.layout.leftSidebarVisible;
  const feedbackAvailable = appMode
    ? !projectOverview && activePane?.content.kind === 'plan' && activePane.content.tab.kind !== 'home'
    : Boolean(snapshot.selected);
  const rightSidebarVisible = feedbackAvailable && (
    sidebarPreview?.side === 'right'
      ? sidebarPreview.width !== 0
      : workspace.layout.rightSidebarVisible);
  const [documentToolbar, setDocumentToolbar] = useState({
    saveStatus: 'Saved locally',
    areaMode: false,
    canAnnotate: false,
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const editComposer = useRef<CommentComposerHandle>(null);
  const surfaceReady = useRef(false);
  const finishRequests = useRef(
    new Map<
      string,
      {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
        target: Window;
      }
    >(),
  );
  const [retryTransition, setRetryTransition] = useState<(() => Promise<void>) | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const saveIntents = useRef(new Map<string, Record<string, unknown>>());
  const browserArea = useRef<HTMLDivElement>(null);
  const homeAddress = useRef<HTMLInputElement>(null);
  const titlebarTabs = useRef<HTMLElement>(null);
  const restoredEditing = useRef<string | null>(null);
  const editWrites = useRef(Promise.resolve());
  const editWriteError = useRef<string | null>(null);
  const failedEditWrite = useRef<(() => Promise<unknown>) | null>(null);
  const transitioning = useRef(false);
  const homeWrites = useRef(Promise.resolve());
  const failedHomeWrite = useRef<(() => Promise<unknown>) | null>(null);
  const readView = useCallback(async (isCurrent: () => boolean) => {
    const next = await invoke<Snapshot>('snapshot');
    if (!isCurrent()) return;
    const nextApplication = await invoke<FullApplicationSnapshot>('applicationSnapshot');
    if (!isCurrent()) return;
    const nextKey = nextApplication.selectedWorkspace;
    const nextSession = nextKey ? nextApplication.workspaces[nextKey] : undefined;
    const nextTab = nextSession?.tabs.find((tab) => tab.id === nextSession.activeTabId);
    const nextPane = nextTab
      ? paneLeaves(nextTab.root).find((pane) => pane.id === nextSession?.activePaneId)
      : undefined;
    const content = nextPane?.content.kind === 'plan' ? nextPane.content : null;
    const selection = content
      ? {
          artifactId: content.artifactId,
          revisionId:
            content.tab.kind === 'document'
              ? content.tab.revisionId
              : (next.artifacts.find((a) => a.id === content.artifactId)?.latestRevision ?? null),
        }
      : nextSession
        ? null
        : next.selected;
    const selectedArtifact = next.artifacts.find(
      (artifact) => artifact.id === selection?.artifactId,
    );
    const selectedProjectId = nextSession?.projectId ?? selectedArtifact?.projectId;
    const selectedProject = next.projects.find((project) => project.id === selectedProjectId);
    const selectedProjectAvailable =
      !selectedProjectId || Boolean(selectedProject && selectedProject.available !== false);
    const loaded = !selectedProjectAvailable || (content && !selectedArtifact)
      ? null
      : content?.tab.kind === 'document' && nextKey && nextPane
        ? await invoke<DocumentResult>('paneDocument', { key: nextKey, paneId: nextPane.id })
        : selection && next.artifacts.some((a) => a.id === selection.artifactId)
          ? await invoke<DocumentResult>('getDocument', selection)
          : null;
    if (!isCurrent()) return;
    const nextBrowser = await invoke<BrowserSnapshot>('browserSnapshot');
    if (!isCurrent()) return;
    const nextWorkspace = await invoke<WorkspaceSnapshot>('workspaceSnapshot');
    if (!isCurrent()) return;
    // Commit one coherent view; an older preview response must never navigate a published frame back.
    setSnapshot(next);
    setDocument(loaded);
    setBrowser(nextBrowser);
    setWorkspace(nextWorkspace);
    browserProjection.current = nextApplication;
    setApplication(nextApplication);
    setProjectId(
      (current) =>
        next.selectedProject ??
        (next.projects.some((p) => p.id === current) ? current : (next.projects[0]?.id ?? '')),
    );
    if (loaded?.editor?.annotationId && restoredEditing.current !== loaded.editor.annotationId) {
      restoredEditing.current = loaded.editor.annotationId;
      const entry = loaded.annotations.find((a) => a.id === loaded.editor?.annotationId);
      if (entry) {
        setEditing(entry);
        setComment(loaded.editor.comment);
        void invoke('editing', { active: true, scope: 'operator' });
      }
    }
    // Only a coherent read refreshes the current surface. Identity prevents a late
    // notification from making the departing iframe read its old document again.
    for (const owner of documentFrames.current.values()) {
      const owningWorkspace = nextApplication.workspaces[owner.key];
      const owningPane = owningWorkspace?.tabs.flatMap(tab => paneLeaves(tab.root))
        .find(pane => pane.id === owner.paneId);
      const owningContent = owningPane?.content;
      if (owner.ready && owner.frame.isConnected && selectedProjectAvailable &&
        next.artifacts.some(artifact => artifact.id === owner.artifactId) &&
        owningContent?.kind === 'plan' && owningContent.tab.kind === 'document' &&
        owningContent.artifactId === owner.artifactId &&
        owningContent.tab.revisionId === owner.revisionId)
        owner.frame.contentWindow?.postMessage(
          { type: 'projector-refresh', artifactId: owner.artifactId, revisionId: owner.revisionId },
          'projector://document',
        );
    }
    if (next.selected && surfaceReady.current && !nextApplication.selectedWorkspace)
      frame.current?.contentWindow?.postMessage(
        { type: 'projector-refresh', ...next.selected },
        'projector://document',
      );
  }, []);
  const refreshQueue = useMemo(
    () => new RefreshQueue(readView, (error) => { if (!bridge.isShuttingDown?.()) setError(message(error)); }),
    [readView],
  );
  const reload = useCallback(() => refreshQueue.request(), [refreshQueue]);
  const shortcutCapture = useCallback((active: boolean) => {
    void invoke('shortcutCapture', { active }).catch((error) => setError(message(error)));
  }, []);
  useEffect(() => {
    refreshQueue.invalidate();
    return bridge.onRefresh(() => refreshQueue.invalidate());
  }, [refreshQueue]);
  useEffect(() => bridge.onShutdown?.(() => { refreshQueue.pause(); }), [refreshQueue]);
  const activePlan = activePane?.content.kind === 'plan' ? activePane.content : null;
  const selected = activePlan
    ? {
        artifactId: activePlan.artifactId,
        revisionId:
          activePlan.tab.kind === 'document'
            ? activePlan.tab.revisionId
            : snapshot.selected?.artifactId === activePlan.artifactId
              ? snapshot.selected.revisionId
              : (snapshot.artifacts.find((item) => item.id === activePlan.artifactId)
                  ?.latestRevision ?? null),
      }
    : appMode
      ? null
      : snapshot.selected;
  const artifact = snapshot.artifacts.find((item) => item.id === selected?.artifactId);
  const artifactProjectAvailable = Boolean(artifact && snapshot.projects.some(
    project => project.id === artifact.projectId && project.available !== false,
  ));
  useEffect(() => {
    setNotification('');
    setNotificationState(null);
    setHandoffSessionId('');
    setCopiedText(null);
  }, [selected?.artifactId]);
  const lastPlan =
    sessionWorkspace?.sessionId === null && !activePane
      ? snapshot.artifacts.find(
          (item) =>
            item.id === snapshot.selected?.artifactId &&
            item.projectId === sessionWorkspace.projectId,
        )
      : null;
  useEffect(() => {
    if (selected?.artifactId && artifactProjectAvailable)
      void invoke('browserRestoreDraft', { artifactId: selected.artifactId })
        .then(() => invoke<BrowserSnapshot>('browserSnapshot'))
        .then(setBrowser)
        .catch((e) => setError(message(e)));
  }, [selected?.artifactId, artifactProjectAvailable]);
  const annotations = (
    appMode
      ? (document?.annotations ?? [])
      : (snapshot.draft?.annotations ?? snapshot.annotations ?? document?.annotations ?? [])
  ).filter((item) => item.artifactId === artifact?.id);
  const planTabs = selected ? workspace.plans[selected.artifactId] : undefined;
  const activeTab =
    activePane?.content.kind === 'plan'
      ? activePane.content.tab
      : planTabs?.tabs.find((t) => t.id === planTabs.activeTabId);
  useEffect(() => {
    const strip = titlebarTabs.current;
    const tab = strip?.querySelector<HTMLElement>('.content-tab.active');
    if (!strip || !tab) return;
    const reveal = () => {
      const bounds = strip.getBoundingClientRect();
      const selectedBounds = tab.getBoundingClientRect();
      if (selectedBounds.left < bounds.left) strip.scrollLeft -= bounds.left - selectedBounds.left;
      else if (selectedBounds.right > bounds.right)
        strip.scrollLeft += selectedBounds.right - bounds.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [activeTab?.id, planTabs?.tabs.length, applicationTab?.id, sessionWorkspace?.tabs.length]);
  const activeBrowser = browser.tabs.find(
    (tab) =>
      activeTab?.kind === 'browser' &&
      tab.id === activeTab.nativeId &&
      tab.artifactId === artifact?.id,
  );
  useEffect(() => {
    surfaceReady.current = false;
  }, [activeTab?.id, selected?.artifactId, selected?.revisionId]);
  useEffect(() => {
    if (activeBrowser) setUrl(activeBrowser.url);
  }, [activeBrowser?.id, activeBrowser?.url]);
  useEffect(() => {
    if (activeTab?.kind === 'home') {
      setUrl(activeTab.address);
      homeAddress.current?.focus();
    }
  }, [activeTab?.id]);
  useEffect(() => {
    if (appMode) return;
    const element = activeBrowser ? browserArea.current : frame.current;
    if (!element) return;
    const update = () => {
      const r = element.getBoundingClientRect();
      void invoke('browserBounds', {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }).catch((e) => setError(message(e)));
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [
    activeBrowser?.id,
    selected?.artifactId,
    selected?.revisionId,
    workspace.layout?.leftSidebarVisible,
    workspace.layout?.rightSidebarVisible,
    appMode,
  ]);
  useEffect(() => {
    if (!appMode) return;
    const owner = activePane ? documentFrames.current.get(activePane.id) : undefined;
    frame.current = owner?.frame ?? null;
    surfaceReady.current = owner?.ready ?? false;
    if (owner?.ready)
      owner.frame.contentWindow?.postMessage(
        { type: 'projector-document-status-request' },
        'projector://document',
      );
  }, [appMode, activePane?.id, framesVersion]);
  useEffect(() => {
    if (!appMode) return;
    let animation = 0;
    const update = () => {
      if (animation) cancelAnimationFrame(animation);
      animation = requestAnimationFrame(() => {
        if (transitioning.current || bridge.isShuttingDown?.()) return;
        const latest = browserProjection.current;
        if (!latest) return;
        const projectionKey = latest.selectedWorkspace;
        if (!projectionKey) return;
        const projectionWorkspace = latest.workspaces[projectionKey];
        const projectionTab = projectionWorkspace?.tabs.find(tab => tab.id === projectionWorkspace.activeTabId);
        const projectionPanes = projectionTab ? paneLeaves(projectionTab.root) : [];
        const views = [...nativeFrames.current.entries()].filter(([viewId,value]) => {
          const content = projectionPanes.find(pane => pane.id === viewId)?.content;
          const rect = value.element.getBoundingClientRect();
          return content?.kind === 'plan' && content.tab.kind === 'browser' &&
            value.element.isConnected && Math.round(rect.width)>0 && Math.round(rect.height)>0;
        }).map(([viewId, value]) => {
          const bounds = value.element.getBoundingClientRect();
          return {
            viewId,
            tabId: value.nativeId,
            bounds: {
              x: Math.round(bounds.x),
              y: Math.round(bounds.y),
              width: Math.round(bounds.width),
              height: Math.round(bounds.height),
            },
            active:
              viewId === projectionWorkspace?.activePaneId &&
              !settingsOpen &&
              !guideOpen &&
              !setup &&
              !renaming &&
              !sessionMetadata,
          };
        });
        void invoke('browserViews', {
          workspaceKey: projectionKey,
          tabId: projectionTab?.id ?? null,
          paneIds: projectionPanes.map(pane => pane.id),
          views: latest.selectedSurface === 'project' || settingsOpen || guideOpen || setup || renaming || sessionMetadata ? [] : views,
        }).catch((error) => setError(message(error)));
      });
    };
    const observer = new ResizeObserver(update);
    for (const value of nativeFrames.current.values()) observer.observe(value.element);
    window.addEventListener('resize', update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      cancelAnimationFrame(animation);
    };
  }, [
    appMode,
    busy,
    framesVersion,
    activePane?.id,
    settingsOpen,
    guideOpen,
    setup,
    renaming,
    sessionMetadata,
  ]);
  useEffect(() => {
    if (!sessionMetadata) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) setSessionMetadata(null);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [sessionMetadata]);
  async function applicationCommand(
    actionName: string,
    params: Record<string, unknown> = {},
    useTransition = true,
  ): Promise<void> {
    const execute = async () => {
      await invoke('applicationCommand', {
        action: actionName,
        projectId: sessionWorkspace?.projectId ?? projectId,
        key: currentKey ?? undefined,
        ...params,
      });
    };
    if (useTransition) await transition(execute);
    else await action(execute);
  }
  const pinnedSessions = application?.pinnedSessionIds ?? [];
  function pinOrder(a: HarnessSession, b: HarnessSession): number {
    return Number(pinnedSessions.includes(b.id)) - Number(pinnedSessions.includes(a.id));
  }
  async function changeSession(session: HarnessSession, archive: boolean): Promise<void> {
    if (sessionChanges.current.has(session.id)) return;
    sessionChanges.current.add(session.id);
    setPendingSessions([...sessionChanges.current]);
    try {
      if (archive) {
        const chat = { notificationId: crypto.randomUUID(), id: session.id, title: session.title, executable: currentSettings.codexExecutable, profile: currentSettings.codexProfile };
        await invoke('harnessArchive', { sessionId: chat.id, archived: true, executable: chat.executable, profile: chat.profile });
        setArchivedChats(previous => [...previous, chat]);
      } else {
        await invoke('harnessPin', { sessionId: session.id, pinned: !pinnedSessions.includes(session.id) });
      }
      await reload();
    } catch (failure) { setError(message(failure)); }
    finally {
      sessionChanges.current.delete(session.id);
      setPendingSessions([...sessionChanges.current]);
    }
  }
  function sessionActions(session: HarnessSession): React.JSX.Element {
    return <SessionActions title={session.title || 'Codex session'} pinned={pinnedSessions.includes(session.id)} pending={pendingSessions.includes(session.id)} onPin={() => void changeSession(session, false)} onArchive={() => void changeSession(session, true)} />;
  }
  function focusPane(paneId: string) {
    if (paneId === activePane?.id && !bottomFocused) return;
    setBottomFocused(false);
    void applicationCommand('focus', { paneId });
  }
  function openPlan(plan: Artifact, revisionId = plan.latestRevision) {
    return transition(() =>
      invoke('applicationCommand', {
        action: 'openPlan',
        projectId: plan.projectId,
        key: sessionWorkspace?.projectId === plan.projectId ? currentKey : undefined,
        artifactId: plan.id,
        revisionId,
      }),
    );
  }
  function planRevision(plan: Artifact): string | null {
    const pane =
      sessionWorkspace?.projectId === plan.projectId
        ? sessionWorkspace.tabs
            .flatMap((tab) => paneLeaves(tab.root))
            .find(
              (pane) =>
                pane.content.kind === 'plan' &&
                pane.content.artifactId === plan.id &&
                pane.content.tab.kind === 'document',
            )
        : undefined;
    if (pane?.content.kind === 'plan' && pane.content.tab.kind === 'document')
      return pane.content.tab.revisionId;
    return (
      workspace.plans[plan.id]?.lastDocumentRevisionId ??
      workspace.plans[plan.id]?.tabs.find((tab) => tab.kind === 'document')?.revisionId ??
      plan.latestRevision
    );
  }
  function openSettings() {
    void transition(async () => {
      await invoke('browserSelect', { tabId: null });
      setSettingsOpen(true);
    });
  }
  useEffect(() => bridge.onOpenSettings?.(openSettings));
  useEffect(() => bridge.onShortcut?.(shortcut));
  useEffect(() =>
    bridge.onPaneFocus?.(({ key, paneId }) => {
      if (key === currentKey && paneId !== activePane?.id) focusPane(paneId);
    }),
  );
  function shortcut(actionName: ShortcutAction) {
    if (settingsOpen) return;
    if (actionName === 'settings') {
      openSettings();
      return;
    }
    if (!sessionWorkspace || !currentKey) return;
    if (actionName === 'bottomPanel') {
      void applicationCommand('bottomToggle');
      return;
    }
    if (actionName === 'newTab') {
      void applicationCommand(
        selected || lastPlan ? 'openHome' : 'newTerminal',
        selected || lastPlan
          ? { artifactId: selected?.artifactId ?? lastPlan?.id }
          : { operationId: crypto.randomUUID() },
      );
      return;
    }
    if (actionName === 'closeTab') {
      if (bottomFocused && bottom?.activeTerminalId)
        void applicationCommand('bottomClose', { terminalId: bottom.activeTerminalId });
      else if (applicationTab) void applicationCommand('closeTab', { tabId: applicationTab.id });
      return;
    }
    if (actionName === 'nextTab' || actionName === 'previousTab') {
      const index = sessionWorkspace.tabs.findIndex((tab) => tab.id === applicationTab?.id),
        delta = actionName === 'nextTab' ? 1 : -1;
      const tab =
        sessionWorkspace.tabs[
          (index + delta + sessionWorkspace.tabs.length) % sessionWorkspace.tabs.length
        ];
      if (tab) void applicationCommand('selectTab', { tabId: tab.id });
      return;
    }
    if (actionName === 'splitRight' || actionName === 'splitDown') {
      if (activePane)
        void applicationCommand('split', {
          paneId: activePane.id,
          axis: actionName === 'splitRight' ? 'horizontal' : 'vertical',
          operationId: crypto.randomUUID(),
        });
      return;
    }
    if (applicationTab) {
      const panes = paneLeaves(applicationTab.root),
        index = panes.findIndex((pane) => pane.id === activePane?.id),
        delta = actionName === 'nextPane' ? 1 : -1;
      focusPane(panes[(index + delta + panes.length) % panes.length].id);
    }
  }
  useEffect(() => {
    const close = (event: PointerEvent | KeyboardEvent) => {
      for (const popover of window.document.querySelectorAll<HTMLDetailsElement>(
        'details.terminal-list[open]',
      ))
        if (
          event instanceof KeyboardEvent
            ? event.key === 'Escape'
            : !popover.contains(event.target as Node)
        )
          popover.open = false;
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (settingsOpen || event.defaultPrevented) return;
      const command = shortcutAction(event, currentSettings.shortcuts);
      if (!command) return;
      event.preventDefault();
      shortcut(command);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
  async function action(callback: () => Promise<unknown>): Promise<void> {
    const resume = refreshQueue.pause();
    setBusy(true);
    setError('');
    try {
      await callback();
      resume();
      await reload();
    } catch (e) {
      resume();
      setError(message(e));
      try {
        await reload();
      } catch {
        /* Preserve the original failure if runtime is disconnected. */
      }
    } finally {
      resume();
      setBusy(false);
    }
  }
  async function finishEditors(retry = false): Promise<void> {
    await homeWrites.current;
    if (failedHomeWrite.current) {
      if (!retry) throw new Error('Local tab save failed. Retry before leaving.');
      await failedHomeWrite.current();
      failedHomeWrite.current = null;
    }
    if (editing) {
      await editWrites.current;
      if (retry && failedEditWrite.current) {
        await failedEditWrite.current();
        failedEditWrite.current = null;
        editWriteError.current = null;
      }
      await editComposer.current?.finish();
    }
    const targets = appMode
      ? [...documentFrames.current.values()]
          .filter((owner) => owner.ready)
          .map((owner) => owner.frame.contentWindow)
          .filter(Boolean)
      : surfaceReady.current
        ? [frame.current?.contentWindow].filter(Boolean)
        : [];
    for (const target of targets) {
      if (!target) continue;
      const id = crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          finishRequests.current.delete(id);
          reject(new Error('Comment editor did not respond. Retry before leaving.'));
        }, 10000);
        finishRequests.current.set(id, { resolve, reject, timer, target });
        target.postMessage({ type: 'projector-finish', id, retry }, 'projector://document');
      });
    }
    await invoke('browserFinishComment');
  }
  function updateHomeAddress(value: string): void {
    setUrl(value);
    if (activeTab?.kind !== 'home' || !selected) return;
    const task = () =>
      invoke('workspaceCommand', {
        artifactId: selected.artifactId,
        action: 'address',
        tabId: activeTab.id,
        url: value,
      });
    homeWrites.current = homeWrites.current.then(async () => {
      try {
        await task();
        failedHomeWrite.current = null;
      } catch (error) {
        failedHomeWrite.current = task;
        setError(message(error));
      }
    });
  }
  useEffect(() => {
    // Native surfaces and the document iframe do not receive shell pointer events.
    // Finish their private editor when the operator clicks back into the shell.
    const outside = (event: PointerEvent) => {
      if (!documentEditing && !browser.annotating) return;
      if ((event.target as Element | null)?.closest('.annotation-comment-composer, .workspace-menu')) return;
      void finishEditors().catch((error) => setError(message(error)));
    };
    window.document.addEventListener('pointerdown', outside);
    return () => window.document.removeEventListener('pointerdown', outside);
  });
  async function transition(
    callback: () => Promise<unknown>,
    retry = false,
    backgroundRefresh = false,
  ): Promise<void> {
    if (transitioning.current) return;
    transitioning.current = true;
    const resume = refreshQueue.pause();
    setBusy(true);
    setError('');
    try {
      await finishEditors(retry);
      setBusy(true);
      await callback();
      resume();
      if (backgroundRefresh) refreshQueue.invalidate();
      else await reload();
      setRetryTransition(null);
    } catch (error) {
      setError(message(error));
      if (bridge.isShuttingDown?.()) return;
      try {
        const confirmation = await invoke<{ pending: boolean }>('applicationConfirmation');
        setRetryTransition(() =>
          confirmation.pending
            ? confirmWorkspaceWrite
            : () => transition(callback, true, backgroundRefresh),
        );
      } catch (confirmationError) {
        setError(`${message(error)}\nWorkspace confirmation failed: ${message(confirmationError)}`);
        // An unavailable confirmation does not prove that the operation failed.
        // Retry reconciliation, never replay the original mutation.
        setRetryTransition(() => confirmWorkspaceWrite);
      }
    } finally {
      resume();
      transitioning.current = false;
      setBusy(false);
    }
  }
  async function confirmWorkspaceWrite(): Promise<void> {
    setBusy(true);
    try {
      await invoke('confirmWorkspaceWrite');
      await reload();
      setError('');
      setRetryTransition(null);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  const tabCommand = (action: string, tabId?: string) => {
    const destination = planTabs?.tabs.find((tab) => tab.id === tabId);
    const samePlanBrowserSelection =
      action === 'select' && activeTab?.kind === 'browser' && destination?.kind === 'browser';
    return transition(
      async () => {
        const result = await invoke<WorkspaceSnapshot>('workspaceCommand', {
          artifactId: selected?.artifactId,
          action,
          tabId,
        });
        // This is acknowledged local metadata, never an optimistic persistent write.
        // A paused refresh invalidates older reads; later publications remain queued.
        if (samePlanBrowserSelection && result.plans) setWorkspace(result);
        return result;
      },
      false,
      samePlanBrowserSelection,
    );
  };
  async function toggleSidebar(side: 'left' | 'right'): Promise<void> {
    const previous = workspace.layout ?? { leftSidebarVisible: true, rightSidebarVisible: true };
    const layout = {
      ...previous,
      [side === 'left' ? 'leftSidebarVisible' : 'rightSidebarVisible']:
        !previous[side === 'left' ? 'leftSidebarVisible' : 'rightSidebarVisible'],
    };
    animateSidebars(layout);
    setWorkspace((current) => ({ ...current, layout }));
    try {
      await invoke('workspaceLayout', layout);
    } catch (error) {
      animateSidebars(previous);
      setWorkspace((current) => ({ ...current, layout: previous }));
      setError(message(error));
    }
  }
  function finishSidebarResize(restore = true) {
    if (
      restore &&
      sidebarPreview?.width === 0 &&
      workspace.layout[
        sidebarPreview.side === 'left' ? 'leftSidebarVisible' : 'rightSidebarVisible'
      ]
    )
      animateSidebars(workspace.layout);
    setSidebarPreview(null);
    if (activeBrowser || nativeFrames.current.size)
      suspendBrowser('sidebar', false);
  }
  function saveSidebarWidth(side: 'left' | 'right', width: number): Promise<void> {
    const write = sidebarWrites.current.then(async () => {
      let committed = false;
      try {
        const current = await invoke<WorkspaceSnapshot>('workspaceSnapshot');
        const layout = {
          ...current.layout,
          ...(width === 0
            ? { [side === 'left' ? 'leftSidebarVisible' : 'rightSidebarVisible']: false }
            : { [side === 'left' ? 'leftSidebarWidth' : 'rightSidebarWidth']: width }),
        };
        await invoke('workspaceLayout', layout);
        setWorkspace((current) => ({ ...current, layout }));
        committed = true;
      } catch (e) {
        setError(message(e));
      } finally {
        finishSidebarResize(!committed);
      }
    });
    sidebarWrites.current = write.catch(() => {});
    return write;
  }
  function closeInformation() {
    setGuideOpen(false);
    setSetup(null);
    const tabId = informationBrowser.current;
    informationBrowser.current = null;
    if (tabId) void action(() => invoke('browserSelect', { tabId }));
    informationFocus.current?.focus();
  }
  async function copy(text: string): Promise<void> {
    try {
      await invoke('copyNotification', { text });
      setCopiedText(text);
      setTimeout(() => setCopiedText(null), 1600);
    } catch (e) {
      setError(message(e));
    }
  }
  async function copyUpdate(text: string, state = notificationState): Promise<void> {
    if (!state) {
      await copy(text);
      return;
    }
    await invoke('copyUpdateMessage', { ...state, sessionId: handoffSessionId || undefined });
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 1600);
    setBottomFocused(false);
  }
  useEffect(() => {
    function relay(event: MessageEvent): void {
      if (!event.source) return;
      const owner = [...documentFrames.current.values()].find(
        (owner) => owner.frame.isConnected && owner.frame.contentWindow !== null && owner.frame.contentWindow === event.source,
      );
      const legacy = !appMode && Boolean(frame.current?.isConnected) && event.source === frame.current?.contentWindow;
      if (
        event.origin !== 'projector://document' ||
        (!owner && !legacy) ||
        !event.data ||
        typeof event.data !== 'object'
      )
        return;
      if (event.data.type === 'projector-focus' && owner) {
        focusPane(owner.paneId);
        return;
      }
      if (event.data.type === 'projector-shortcut' && typeof event.data.action === 'string') {
        if (Object.hasOwn(currentSettings.shortcuts, event.data.action))
          shortcut(event.data.action as ShortcutAction);
        return;
      }
      if (event.data.type === 'projector-document-status') {
        if (owner && owner.paneId !== activePane?.id) return;
        setDocumentToolbar({
          saveStatus: typeof event.data.saveStatus === 'string' ? event.data.saveStatus : '',
          areaMode: event.data.areaMode === true,
          canAnnotate: event.data.canAnnotate === true,
        });
        return;
      }
      if (event.data.type === 'projector-finished' && typeof event.data.id === 'string') {
        const pending = finishRequests.current.get(event.data.id);
        if (pending && pending.target === event.source) {
          clearTimeout(pending.timer);
          finishRequests.current.delete(event.data.id);
          if (event.data.error) pending.reject(new Error(event.data.error));
          else pending.resolve();
        }
        return;
      }
      const request = event.data as {
        type?: unknown;
        id?: unknown;
        method?: unknown;
        params?: unknown;
      };
      if (
        request.type !== 'projector-request' ||
        typeof request.id !== 'string' ||
        typeof request.method !== 'string'
      )
        return;
      const target = event.source as Window;
      const sourceFrame = owner?.frame ?? frame.current;
      const reply = (value: unknown, origin: string) => {
        if (sourceFrame?.isConnected && sourceFrame.contentWindow === target)
          target.postMessage(value, origin);
      };
      const params =
        request.params && typeof request.params === 'object'
          ? (request.params as Record<string, unknown>)
          : {};
      const allowed = [
        'getDocument',
        'setValue',
        'addAnnotation',
        'editing',
        'saveEditor',
        'captureDocumentArea',
        'browserShowCapture',
        'setViewState',
        'captureAnnotationState',
        'annotationNavigated',
        'previewing',
      ];
      const identity = owner ?? selected;
      if (
        !allowed.includes(request.method) ||
        !identity ||
        (!['editing', 'previewing'].includes(request.method) &&
          (params.artifactId !== identity.artifactId || params.revisionId !== identity.revisionId))
      ) {
        reply(
          {
            type: 'projector-response',
            id: request.id,
            error: 'Document operation is not allowed.',
          },
          'projector://document',
        );
        return;
      }
      if (request.method === 'previewing') {
        if (!owner || owner.paneId === activePane?.id) setDocumentPreview(params.active === true);
        reply(
          { type: 'projector-response', id: request.id, result: {} },
          'projector://document',
        );
        return;
      }
      if (request.method === 'annotationNavigated') {
        setJump(null);
        reply(
          { type: 'projector-response', id: request.id, result: {} },
          'projector://document',
        );
        return;
      }
      if (['setValue', 'saveEditor', 'setViewState'].includes(String(request.method)))
        setSavingCount((c) => c + 1);
      if (request.method === 'editing') {
        const id = owner ? `pane:${owner.key}:${owner.paneId}` : 'pane:legacy';
        if (params.active === true) editingFrames.current.add(id);
        else editingFrames.current.delete(id);
        setDocumentEditing(editingFrames.current.size > 0);
      }
      const saveKey = `${identity.artifactId}:${String(request.method)}:${String(params.widgetId ?? 'editor')}`;
      let method = request.method;
      let input = params;
      if (method === 'editing')
        input = {
          active: params.active,
          scope: owner ? `pane:${owner.key}:${owner.paneId}` : 'pane:legacy',
        };
      if (owner) {
        if (method === 'getDocument') {
          method = 'paneDocument';
          input = { key: owner.key, paneId: owner.paneId,
            artifactId: owner.artifactId, revisionId: owner.revisionId };
        }
        if (method === 'setViewState') {
          method = 'paneView';
          input = {
            key: owner.key,
            paneId: owner.paneId,
            view: params.view,
            scrollTop: params.scrollTop,
          };
        }
        if (method === 'captureAnnotationState') {
          method = 'paneAnnotationState';
          input = { key: owner.key, paneId: owner.paneId, view: params.view };
        }
        if (method === 'captureDocumentArea' || method === 'browserShowCapture')
          input = { ...params, paneId: owner.paneId };
      }
      void bridge
        .invoke(method, input)
        .then((result) => {
          if (['setValue', 'saveEditor', 'setViewState'].includes(String(request.method)))
            setFailedAutosaves((previous) => {
              const next = new Set(previous);
              next.delete(saveKey);
              return next;
            });
          reply(
            {
              type: 'projector-response',
              id: request.id,
              result: method === 'paneView' ? { saved: true, view: result } : result,
            },
            'projector://document',
          );
          if (
            request.method === 'getDocument' &&
            jump !== null &&
            jump.artifactId === params.artifactId &&
            jump.revisionId === params.revisionId
          )
            reply(
              { type: 'projector-jump', annotation: jump },
              'projector://document',
            );
          if (!['getDocument', 'editing'].includes(String(request.method)))
            void reload().catch((e) => setError(message(e)));
        })
        .catch((e) => {
          if (['setValue', 'saveEditor', 'setViewState'].includes(String(request.method)))
            setFailedAutosaves((previous) => new Set(previous).add(saveKey));
          reply(
            { type: 'projector-response', id: request.id, error: message(e) },
            'projector://document',
          );
        })
        .finally(() => {
          if (['setValue', 'saveEditor', 'setViewState'].includes(String(request.method)))
            setSavingCount((c) => c - 1);
        });
    }
    window.addEventListener('message', relay);
    return () => window.removeEventListener('message', relay);
  });
  useEffect(() => {
    for (const owner of documentFrames.current.values())
      if (owner.ready)
        owner.frame.contentWindow?.postMessage(
          { type: 'projector-shortcuts', shortcuts: currentSettings.shortcuts },
          'projector://document',
        );
  }, [framesVersion, currentSettings.shortcuts]);
  function sendJump(): void {
    if (jump)
      frame.current?.contentWindow?.postMessage(
        { type: 'projector-jump', annotation: jump },
        'projector://document',
      );
  }
  useEffect(() => {
    sendJump();
  }, [jump, document]);
  const surfaceUrl = selected
    ? `projector://document/index.html?surface=1&artifactId=${encodeURIComponent(selected.artifactId)}&revisionId=${encodeURIComponent(selected.revisionId ?? '')}&shellOrigin=${encodeURIComponent(window.location.origin)}`
    : '';
  function persistEdit(annotation: Annotation, value: string): void {
    setComment(value);
    const task = () =>
      invoke('saveEditor', {
        artifactId: annotation.artifactId,
        revisionId: annotation.revisionId,
        editor: {
          selection: annotationSelection(annotation),
          comment: value,
          annotationId: annotation.id,
        },
      });
    editWrites.current = editWrites.current.then(async () => {
      try {
        await task();
        failedEditWrite.current = null;
        editWriteError.current = null;
      } catch (error) {
        failedEditWrite.current = task;
        editWriteError.current = message(error);
        setError(message(error));
      }
    });
  }
  async function finishEdit(
    annotation: Annotation,
    mode: 'save' | 'cancel' | 'delete',
  ): Promise<void> {
    {
      await editWrites.current;
      if (mode === 'save') {
        if (editWriteError.current) throw new Error(editWriteError.current);
        await invoke('editAnnotation', { annotationId: annotation.id, comment: comment.trim() });
      } else if (mode === 'delete') {
        await invoke('deleteAnnotation', { annotationId: annotation.id });
      }
      await invoke('saveEditor', {
        artifactId: annotation.artifactId,
        revisionId: annotation.revisionId,
        editor: null,
      });
      setEditing(null);
      await invoke('editing', { active: false, scope: 'operator' });
    }
    // finishEditors may call this while transition has suspended reads. Its
    // caller will await the final refresh after the private write has completed.
    if (transitioning.current) refreshQueue.invalidate();
    else await reload();
  }
  async function jumpTo(annotation: Annotation): Promise<void> {
    if (annotation.kind === 'browser-area') {
      await transition(() =>
        invoke('browserShowCapture', {
          artifactId: annotation.artifactId,
          annotationId: annotation.id,
          paneId: activePlan?.artifactId === annotation.artifactId ? activePane?.id : undefined,
        }),
      );
      return;
    }
    let opened = false;
    await transition(async () => {
      await invoke('browserSelect', { tabId: null });
      await invoke('openArtifact', {
        artifactId: annotation.artifactId,
        revisionId: annotation.revisionId,
      });
      setJump(annotation);
      opened = true;
    });
    if (annotation.kind === 'document-area' && opened)
      await action(async () => {
        const current = await invoke<ApplicationWorkspaceSnapshot>('applicationSnapshot');
        const workspace = current.selectedWorkspace
          ? current.workspaces[current.selectedWorkspace]
          : undefined;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await invoke('browserShowCapture', {
          artifactId: annotation.artifactId,
          annotationId: annotation.id,
          paneId: workspace?.activePaneId ?? undefined,
        });
      });
  }
  async function startProjectSession(project: Project): Promise<void> {
    if (creatingSession.current || project.available === false) return;
    creatingSession.current = true;
    const operationId = crypto.randomUUID();
    try {
      await transition(async () => {
        await invoke('applicationCommand', {
          action: 'newCodex',
          projectId: project.id,
          operationId,
        });
        setCollapsed((previous) => {
          const next = new Set(previous);
          next.delete(project.id);
          return next;
        });
      });
    } finally {
      creatingSession.current = false;
    }
  }
  async function openProjectMenu(project: Project): Promise<void> {
    try {
      const { action: selectedAction } = await invoke<{
        action: 'new' | 'refresh' | 'locate' | 'remove' | null;
      }>('projectMenu', { projectId: project.id });
      if (selectedAction === 'new') await startProjectSession(project);
      else if (selectedAction === 'refresh') await action(() => invoke('harnessRefresh'));
      else if (selectedAction === 'locate' || selectedAction === 'remove')
        await transition(() =>
          invoke(selectedAction === 'locate' ? 'locateProject' : 'removeProject', {
            projectId: project.id,
          }),
        );
    } catch (error) {
      setError(message(error));
    }
  }
  async function openPlanMenu(plan: Artifact): Promise<void> {
    try {
      const { action: selectedAction } = await invoke<{ action: 'rename' | 'archive' | 'restore' | null }>('planMenu', {
        artifactId: plan.id,
      });
      if (selectedAction === 'archive' || selectedAction === 'restore') {
        await archivePlan(plan, selectedAction === 'archive');
        return;
      }
      if (selectedAction === 'rename')
        await transition(async () => {
          informationBrowser.current = activeBrowser?.id ?? null;
          informationFocus.current = window.document.activeElement as HTMLElement;
          await invoke('browserSelect', { tabId: null });
          setRenameError('');
          setRenaming({ artifactId: plan.id, title: plan.title, operationId: crypto.randomUUID() });
        });
    } catch (error) {
      setError(message(error));
    }
  }
  async function archivePlan(plan: Artifact, archived: boolean) {
    await transition(() => invoke('archivePlan', { artifactId: plan.id, archived, operationId: crypto.randomUUID() }));
  }
  async function openProjectTerminal(record: TerminalRecord) {
    const shared = application?.bottom[record.projectId]?.tabs.includes(record.id);
    const owner = !shared ? Object.entries(application?.workspaces ?? {}).find(([, entry]) =>
      entry.projectId === record.projectId && entry.sessionId !== null && entry.tabs.some(tab =>
        paneLeaves(tab.root).some(pane => (pane.content.kind === 'terminal' || pane.content.kind === 'session') && pane.content.terminalId === record.id))) : undefined;
    setBottomFocused(!owner);
    await transition(async () => {
      if (owner) await invoke('applicationCommand', { action: 'select', projectId: record.projectId, key: owner[0] });
      await invoke('applicationCommand', { action: 'showTerminal', projectId: record.projectId,
        key: owner?.[0] ?? currentKey, terminalId: record.id, area: owner ? 'main' : 'bottom' });
    });
  }
  async function showProject(project: Project) {
    setBottomFocused(false);
    setShowArchivedPlans(false);
    await transition(() => invoke('applicationCommand', { action: 'projectOverview', projectId: project.id }));
  }
  function closeRename(): void {
    if (renameSubmitting.current) return;
    setRenaming(null);
    closeInformation();
  }
  async function saveRename(): Promise<void> {
    if (!renaming?.title.trim() || renameSubmitting.current) return;
    renameSubmitting.current = true;
    setRenameBusy(true);
    setRenameError('');
    try {
      await invoke('renamePlan', { ...renaming, title: renaming.title.trim() });
      renameSubmitting.current = false;
      closeRename();
      await reload();
    } catch (error) {
      setRenameError(message(error));
    } finally {
      renameSubmitting.current = false;
      setRenameBusy(false);
    }
  }
  function agentMessage(plan: Artifact): string {
    return `Prepare the existing Projector plan. Project ID: ${plan.projectId}. Artifact ID: ${plan.id}. Read read_artifact with artifactId and part="manifest" for the sourcePath and sourceFile. Explicitly attach your known originSession with attach_artifact_session (artifactId, originSession, operationId); ask me if you do not know your session ID, never infer it. Write the MDX source into the returned sourceFile and publish the first revision of this same artifact. Keep its existing private workspace and annotations. Do not create a replacement artifact.`;
  }
  function sidebarToggle(side: 'left' | 'right') {
    const visible = side === 'left' ? leftSidebarVisible : rightSidebarVisible;
    const label = `${visible ? 'Hide' : 'Show'} ${side === 'left' ? 'projects' : 'feedback'} sidebar`;
    return (
      <button
        className="sidebar-toggle"
        aria-label={label}
        title={label}
        aria-pressed={visible}
        disabled={side === 'right' && !feedbackAvailable}
        onClick={() => void toggleSidebar(side)}
      >
        <Icon name={side === 'left' ? 'sidebar-left' : 'sidebar-right'} />
      </button>
    );
  }
  const requestedLeft =
    sidebarPreview?.side === 'left'
      ? sidebarPreview.width || (workspace.layout.leftSidebarWidth ?? SIDEBAR_DEFAULT.left)
      : (workspace.layout.leftSidebarWidth ?? SIDEBAR_DEFAULT.left);
  const requestedRight =
    sidebarPreview?.side === 'right'
      ? sidebarPreview.width || (workspace.layout.rightSidebarWidth ?? SIDEBAR_DEFAULT.right)
      : (workspace.layout.rightSidebarWidth ?? SIDEBAR_DEFAULT.right);
  const fitted = fitSidebars(
    leftSidebarVisible ? requestedLeft : 0,
    rightSidebarVisible ? requestedRight : 0,
    windowWidth,
  );
  function renderSessionHome(sessionId: string): React.ReactNode {
    const knownSession = application?.harnesses.sessions.find(item => item.id === sessionId);
    if (!knownSession && application && !application.harnesses.error) {
      return <div className="session-home new-tab-home">
        <h2>Session unavailable</h2>
        <p className="muted">This session is no longer available in Codex.</p>
        <button className="primary" disabled={busy} onClick={() => void applicationCommand('newCodex', {
          operationId: crypto.randomUUID(),
        })}>Start new session</button>
      </div>;
    }
    const session = knownSession ?? {
      id: sessionId, title: 'Codex session', cwd: snapshot.projects.find(item => item.id === sessionWorkspace?.projectId)?.path ?? '',
      processState: 'unknown', terminalId: undefined,
    };
    return (
              <div className="session-home new-tab-home">
                <h2>{session.title || 'Codex session'}</h2>
                <p className="muted session-summary">{session.processState === 'unknown'
                  ? 'Session from history · external process state unknown'
                  : `Process: ${session.processState}`}</p>
                <details className="session-details"><summary>Details</summary><dl>
                  <dt>Session ID</dt>
                  <dd>{session.id}</dd>
                  <dt>Working folder</dt>
                  <dd>{session.cwd}</dd>
                  <dt>Process</dt>
                  <dd>
                    {session.processState === 'unknown'
                      ? 'Unknown · this session was discovered from history'
                      : session.processState}
                  </dd>
                </dl>
                  <button onClick={() => void copy(session.id)}>Copy session ID</button>
                  <button onClick={() => void copy(session.cwd)}>Copy working folder</button>
                </details>
                {session.processState === 'running' && session.terminalId ? (
                  <button
                    className="primary"
                    onClick={() =>
                      void applicationCommand('showTerminal', {
                        terminalId: session.terminalId,
                      })
                    }
                  >
                    Open terminal
                  </button>
                ) : (
                  <>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void applicationCommand('newCodex', {
                          sessionId: session.id,
                          operationId: crypto.randomUUID(),
                        })
                      }
                    >
                      Resume
                    </button>
                  </>
                )}
              </div>
    );
  }
  function renderApplicationPane(
    pane: Extract<PaneNode, { kind: 'pane' }>,
    active: boolean,
  ): React.ReactNode {
    if (!currentKey || !application) return null;
    const content = pane.content;
    if (content.kind === 'session' && !application.terminals.some(record => record.id === content.terminalId)) return renderSessionHome(content.sessionId);
    if (content.kind === 'terminal' || content.kind === 'session') {
      const record = application.terminals.find((record) => record.id === content.terminalId);
      return record ? (
        <TerminalPane
          record={record}
          viewId={pane.id}
          active={
            active &&
            !bottomFocused &&
            !settingsOpen &&
            !guideOpen &&
            !setup &&
            !renaming &&
            !sessionMetadata
          }
          settings={currentSettings}
          bridge={bridge}
          onFocus={() => focusPane(pane.id)}
          onActivateForDrop={async () => {
            if (settingsOpen || guideOpen || setup || renaming || sessionMetadata || busy) return false;
            setBottomFocused(false);
            await applicationCommand('focus', { paneId: pane.id });
            const state = await invoke<FullApplicationSnapshot>('applicationSnapshot');
            return state.selectedSurface !== 'project' && state.selectedWorkspace === currentKey && state.workspaces[currentKey!]?.activePaneId === pane.id;
          }}
          onChange={() => void reload()}
          onResume={
            record.harnessSessionId
              ? () =>
                  void applicationCommand('newCodex', {
                    sessionId: record.harnessSessionId,
                    operationId: crypto.randomUUID(),
                  })
              : undefined
          }
        />
      ) : (
        <div className="new-tab-home">Terminal unavailable</div>
      );
    }
    const plan = snapshot.artifacts.find((plan) => plan.id === content.artifactId);
    if (!plan) return <div className="new-tab-home">Plan unavailable</div>;
    const owningProject = snapshot.projects.find(project => project.id === plan.projectId);
    if (!owningProject || owningProject.available === false)
      return <div className="new-tab-home">Project folder unavailable</div>;
    if (content.tab.kind === 'document')
      return (
        <PlanDocumentPane
          content={content}
          paneId={pane.id}
          workspaceKey={currentKey}
          bridge={bridge}
          refreshToken={snapshot}
          register={registerDocument}
          onFocus={() => focusPane(pane.id)}

          onNewTab={() => void applicationCommand('openHome', { artifactId: content.artifactId })}
          onCopy={() => void copy(agentMessage(plan))}
          message={agentMessage(plan)}
        />
      );
    if (content.tab.kind === 'browser') {
      const nativeId = content.tab.nativeId;
      const native = browser.tabs.find((tab) => tab.id === nativeId);
      return (
        <BrowserWorkspacePane
          paneId={pane.id}
          nativeId={content.tab.nativeId}
          error={native?.error}
          register={registerBrowser}
          onFocus={() => focusPane(pane.id)}

        />
      );
    }
    return (
      <HomeWorkspacePane
        address={content.tab.address}
        busy={busy}
        onFocus={() => focusPane(pane.id)}
        onAddress={(value) => {
          const task = () =>
            invoke('applicationCommand', {
              action: 'address',
              projectId: sessionWorkspace?.projectId,
              key: currentKey,
              paneId: pane.id,
              url: value,
            });
          homeWrites.current = homeWrites.current.then(async () => {
            try {
              await task();
              failedHomeWrite.current = null;
            } catch (error) {
              failedHomeWrite.current = task;
              setError(message(error));
            }
          });
        }}
        onOpen={(url) => void applicationCommand('openUrl', { paneId: pane.id, url })}
      />
    );
  }
  return (
    <div
      style={
        {
          '--left-sidebar-width': `${fitted.left}px`,
          '--right-sidebar-width': `${fitted.right}px`,
          '--left-sidebar-content-width': `${sidebarAnimationWidths.left}px`,
          '--right-sidebar-content-width': `${sidebarAnimationWidths.right}px`,
        } as React.CSSProperties
      }
      className={`app ${sidebarAnimating ? 'sidebar-animating' : ''} ${!leftSidebarVisible ? 'left-sidebar-hidden' : ''} ${!rightSidebarVisible ? 'right-sidebar-hidden' : ''}`}
    >
      {archivedChats[0] && <ArchiveNotice key={archivedChats[0].notificationId} chat={archivedChats[0]} onDismiss={() => setArchivedChats(previous => previous.slice(1))} onUndo={async chat => {
        await invoke('harnessArchive', { sessionId: chat.id, archived: false, executable: chat.executable, profile: chat.profile });
        await reload();
      }} />}
      <header className="window-titlebar" role="toolbar" aria-label="Window toolbar">
        {leftSidebarVisible && (
          <div className="titlebar-section titlebar-left">
            <div className="titlebar-brand" aria-label="Projector">
              <span className="titlebar-brand-mark" aria-hidden="true">P</span>
              <span className="titlebar-brand-name">Projector</span>
            </div>
            {sidebarToggle('left')}
          </div>
        )}
        <div className="titlebar-section titlebar-center">
          {!leftSidebarVisible && sidebarToggle('left')}
          {appMode ? (
            <nav
              className="content-tabs"
              role="tablist"
              aria-label="Workspace tabs"
              ref={titlebarTabs}
            >
              {(!projectOverview ? (sessionWorkspace?.tabs ?? []) : []).map((tab) => {
                const panes = paneLeaves(tab.root),
                  content =
                    panes.find((pane) => pane.id === sessionWorkspace?.activePaneId)?.content ??
                    panes[0].content;
                const pinned = panes.some(pane => pane.content.kind === 'session');
                const terminal =
                  content.kind === 'terminal' || content.kind === 'session'
                    ? application?.terminals.find((record) => record.id === content.terminalId)
                    : null;
                const title =
                  pinned || content.kind === 'session' ? 'Codex' : content.kind === 'terminal'
                    ? (terminal?.title ?? 'Terminal')
                    : content.tab.kind === 'document'
                      ? 'Plan'
                      : content.tab.kind === 'home'
                        ? 'New tab'
                        : content.tab.title || 'Browser';
                return (
                  <div
                    className={`content-tab ${applicationTab?.id === tab.id ? 'active' : ''}`}
                    key={tab.id}
                  >
                    <button
                      role="tab"
                      aria-selected={applicationTab?.id === tab.id}
                      disabled={busy}
                      title={pinned ? 'Session tab: cannot be closed' : title}
                      onMouseDown={(event) => {
                        if (event.button === 1) event.preventDefault();
                      }}
                      onAuxClick={(event) => {
                        if (event.button === 1) {
                          event.preventDefault();
                          if (pinned) return;
                          void applicationCommand('closeTab', { tabId: tab.id });
                        }
                      }}
                      onClick={() => {
                        setBottomFocused(false);
                        void applicationCommand('selectTab', { tabId: tab.id });
                      }}
                    >
                      <span aria-hidden="true">
                        {pinned || content.kind === 'terminal' || content.kind === 'session'
                          ? '›_'
                          : content.tab.kind === 'document'
                            ? '▤'
                            : '◎'}
                      </span>
                      <span>
                        {title}
                        {panes.length > 1 ? ` · ${panes.length}` : ''}
                      </span>
                    </button>
                    {!pinned && (
                    <button
                      className="tab-close"
                      disabled={busy}
                      aria-label={`Close ${title.toLowerCase()} tab`}
                      onClick={() => void applicationCommand('closeTab', { tabId: tab.id })}
                    >
                      <Icon name="close" />
                    </button>
                    )}
                  </div>
                );
              })}
            </nav>
          ) : (
            selected && (
              <nav
                className="content-tabs"
                role="tablist"
                aria-label="Plan tabs"
                ref={titlebarTabs}
              >
                {planTabs?.tabs.map((tab) => (
                  <div
                    className={`content-tab ${activeTab?.id === tab.id ? 'active' : ''}`}
                    key={tab.id}
                  >
                    <button
                      role="tab"
                      aria-selected={activeTab?.id === tab.id}
                      disabled={busy}
                      onAuxClick={(e) => {
                        if (e.button === 1) {
                          e.preventDefault();
                          void tabCommand('close', tab.id);
                        }
                      }}
                      onMouseDown={(e) => {
                        if (e.button === 1) e.preventDefault();
                      }}
                      onClick={() => void tabCommand('select', tab.id)}
                      title={
                        tab.kind === 'browser'
                          ? tab.title
                          : tab.kind === 'home'
                            ? 'New tab'
                            : artifact?.title
                      }
                    >
                      <span aria-hidden="true">{tab.kind === 'document' ? '▤' : '◎'}</span>
                      <span>
                        {tab.kind === 'document'
                          ? 'Plan'
                          : tab.kind === 'home'
                            ? 'New tab'
                            : tab.title || 'Browser'}
                      </span>
                    </button>
                    <button
                      className="tab-close"
                      disabled={busy}
                      aria-label={`Close ${tab.kind === 'document' ? 'plan' : tab.kind === 'home' ? 'new tab' : tab.title || 'browser'} tab`}
                      onClick={() => void tabCommand('close', tab.id)}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                ))}
              </nav>
            )
          )}
          {appMode ? <WorkspaceMenu label="New tab" icon="plus" onOpenChange={open => workspaceMenuChanged('New tab',open)} disabled={busy} items={[
            {label: 'New terminal', action: () => void applicationCommand('newTerminal', {operationId: crypto.randomUUID()})},
            {label: 'New browser tab', disabled: !selected && !lastPlan, action: () => shortcut('newTab')},
          ]} /> : <button className="new-tab" title="New tab" aria-label="New tab"
            disabled={busy || !selected} onClick={() => void tabCommand('new')}><Icon name="plus" /></button>}
          <span className="titlebar-drag-space" />

          {appMode && <div className="titlebar-workspace-actions" role="toolbar" aria-label="Workspace controls">
            <button aria-label="Toggle project terminals" title="Project terminals" aria-pressed={bottom?.visible ?? false}
              onClick={() => shortcut('bottomPanel')}><Icon name="terminal" /></button>
            <WorkspaceMenu label="Workspace actions" icon="more" onOpenChange={open => workspaceMenuChanged('Workspace actions',open)} disabled={busy} items={[
              {label: 'Split right', disabled: !activePane, action: () => shortcut('splitRight')},
              {label: 'Split down', disabled: !activePane, action: () => shortcut('splitDown')},
              ...(activePane && activePane.content.kind !== 'session' ? [{label: 'Close panel', action: () => void applicationCommand('closePane', {paneId: activePane.id})}] : []),
              {label: 'All terminals', children: (application?.terminals ?? []).filter(record => record.projectId === sessionWorkspace?.projectId).map(record => ({
                id: record.id, label: `${record.title} · ${record.status}`,
                action: () => void applicationCommand('showTerminal', {terminalId: record.id}),
              }))},
            ]} />
          </div>}
          {!rightSidebarVisible && sidebarToggle('right')}
        </div>
        {rightSidebarVisible && (
          <div className="titlebar-section titlebar-right">
            {sidebarToggle('right')}
            <span className="titlebar-drag-space" />
          </div>
        )}
      </header>
      {(['left', 'right'] as const).map(
        (side) =>
          ((side === 'left' ? leftSidebarVisible : rightSidebarVisible) ||
            sidebarPreview?.side === side) && (
            <SidebarResizer
              key={side}
              side={side}
              width={side === 'left' ? requestedLeft : requestedRight}
              position={fitted[side]}
              onStart={() => {
                setSidebarPreview({
                  side,
                  width: side === 'left' ? requestedLeft : requestedRight,
                });
                if (activeBrowser || nativeFrames.current.size)
                  suspendBrowser('sidebar', true);
              }}
              onPreview={(width) => {
                if ((width === 0) !== (sidebarPreview?.width === 0)) {
                  animateSidebars({
                    ...workspace.layout,
                    leftSidebarVisible,
                    rightSidebarVisible,
                    [side === 'left' ? 'leftSidebarVisible' : 'rightSidebarVisible']: width !== 0,
                    ...(width === 0
                      ? {}
                      : {
                          [side === 'left' ? 'leftSidebarWidth' : 'rightSidebarWidth']: width,
                        }),
                  });
                }
                setSidebarPreview({ side, width });
              }}
              onCommit={(width) => saveSidebarWidth(side, width)}
              onCancel={finishSidebarResize}
            />
          ),
      )}
      {sidebarPreview && <div className="sidebar-resize-shield" />}
      <div className="sidebar-viewport">
        <aside className="sidebar" ref={leftSidebarContent}>
          <div className="project-tree">
            <div className="tree-heading">Projects</div>
            {snapshot.projects.map((item) => (
              <section key={item.id}>
                <div
                  className="project-row"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void openProjectMenu(item);
                  }}
                >
                  <button className="project-toggle" aria-label={`${collapsed.has(item.id) ? 'Expand' : 'Collapse'} sessions in ${item.path.split('/').at(-1)}`}
                    aria-expanded={!collapsed.has(item.id)} onClick={() => setCollapsed(previous => {
                      const next = new Set(previous); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next;
                    })}><Icon name={collapsed.has(item.id) ? 'right' : 'down'} /></button>
                  <button className={`project-name ${item.id === projectId ? 'current' : ''}`} title={item.path}
                    disabled={busy} aria-label={`Open project ${item.path.split('/').at(-1)}`} onClick={() => void showProject(item)}>
                    {item.path.split('/').filter(Boolean).at(-1)}
                  </button>
                  <div className="project-row-actions">
                    <button
                      aria-label={`Project actions for ${item.path.split('/').at(-1)}`}
                      title="Project actions"
                      disabled={busy}
                      onClick={() => void openProjectMenu(item)}
                    >
                      <Icon name="more" />
                    </button>
                    <button
                      aria-label={`New Codex session in ${item.path.split('/').at(-1)}`}
                      title="New Codex session"
                      disabled={busy || item.available === false}
                      onClick={() => void startProjectSession(item)}
                    >
                      <Icon name="plus" />
                    </button>
                  </div>
                </div>
                {item.available === false && !collapsed.has(item.id) && (
                  <small className="project-unavailable">Folder unavailable</small>
                )}
                {!collapsed.has(item.id) && (
                  <div className="project-sessions">
                    {application?.harnesses.sessions
                      .filter((session) => session.projectId === item.id)
                      .sort(pinOrder)
                      .map((session) => (
                        <div
                          key={session.id}
                          className={`harness-session ${sessionWorkspace?.sessionId === session.id && sessionWorkspace.projectId === item.id ? 'active' : ''}`}
                        >
                          <button
                            className="session-select"
                            title={`${session.title} · ${session.id} · ${session.processState === 'unknown' ? 'Process state unknown' : session.processState}`}
                            onClick={() => {
                              setBottomFocused(false);
                              void transition(() =>
                                invoke('applicationCommand', {
                                  action: 'select',
                                  projectId: item.id,
                                  sessionId: session.id,
                                }),
                              );
                            }}
                          >
                            <span aria-hidden="true">›_</span>
                            <span className="session-title">{session.title || 'Codex session'}</span>
                            {session.processState === 'running' && <span className="runtime-dot" />}
                          </button>
                          {sessionActions(session)}
                        </div>
                      ))}
                    {!application?.harnesses.sessions.some(
                      (session) => session.projectId === item.id,
                    ) && <small className="tree-empty">No sessions to display</small>}
                  </div>
                )}
              </section>
            ))}
            {(application?.harnesses.sessions.filter((session) => session.projectId === null)
              .length ?? 0) > 0 && (
              <details className="other-sessions">
                <summary>Other sessions</summary>
                {application?.harnesses.sessions
                  .filter((session) => session.projectId === null)
                  .sort(pinOrder)
                  .map((session) => (
                    <div key={session.id}>
                      <div className="other-session-heading"><strong>{session.title || 'Codex session'}</strong>{sessionActions(session)}</div>
                      <small title={session.cwd}>{session.cwd}</small>
                      <small>Process state unknown · open its project folder to resume.</small>
                      <button
                        onClick={() =>
                          void transition(async () => {
                            const metadata = await invoke<HarnessSession>('harnessRead', {
                              sessionId: session.id,
                            });
                            await invoke('browserSelect', { tabId: null });
                            setSessionMetadata(metadata);
                          })
                        }
                      >
                        Read metadata
                      </button>
                    </div>
                  ))}
              </details>
            )}
            <button
              className="subtle full"
              disabled={busy}
              onClick={() => void transition(() => invoke('chooseProject'))}
            >
              + Open project folder
            </button>
          </div>
          <nav className="sidebar-bottom" aria-label="Application utilities">
            <button className="sidebar-utility" onClick={openSettings}>
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z" /><circle cx="12" cy="12" r="3" /></svg>
              <span>Settings</span>
            </button>
            <button
              className="sidebar-utility"
              onClick={() =>
                void transition(async () => {
                  informationBrowser.current = activeBrowser?.id ?? null;
                  informationFocus.current = window.document.activeElement as HTMLElement;
                  await invoke('browserSelect', { tabId: null });
                  setGuideOpen(true);
                })
              }
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 3h12a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2V3Zm0 14h14M8 7h6M8 10h6" /></svg>
              <span>Projector guide</span>
            </button>
            <button
              className="sidebar-utility"
              aria-label="MCP connection"
              title="MCP connection · Local runtime active"
              onClick={() =>
                void transition(async () => {
                  const connection = await invoke<import('../shared/protocol').McpSetup>('setup');
                  informationBrowser.current = activeBrowser?.id ?? null;
                  informationFocus.current = window.document.activeElement as HTMLElement;
                  await invoke('browserSelect', { tabId: null });
                  setSetup(connection);
                })
              }
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4" /></svg>
              <span>MCP connection</span>
              <span className="runtime-dot footer-runtime" role="img" aria-label="Local runtime active" />
            </button>
          </nav>
        </aside>
      </div>
      <main className="workspace">
        {selected && (
          <header className={`plan-header ${activeBrowser ? 'browser-plan-header' : ''}`}>
            {selected && (
              <div className="version-tools">
                {selected.revisionId && (
                  <label>
                    <select
                      disabled={busy}
                      aria-label="Document version"
                      value={selected.revisionId}
                      onChange={(e) => {
                        const revisionId = e.currentTarget.value;
                        void transition(() =>
                          invoke(
                            appMode ? 'applicationCommand' : 'openArtifact',
                            appMode
                              ? {
                                  action: 'selectVersion',
                                  projectId: sessionWorkspace?.projectId,
                                  key: currentKey,
                                  paneId: activePane?.id,
                                  revisionId,
                                }
                              : { artifactId: selected.artifactId, revisionId },
                          ),
                        );
                      }}
                    >
                      {(artifact?.revisions ?? [selected.revisionId]).map((r, i) => {
                        const id = typeof r === 'string' ? r : r.id;
                        return (
                          <option key={id} value={id}>
                            Version {i + 1}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                )}
                <span className={`status ${document?.approved ? 'approved' : ''}`}>
                  {document?.draft
                    ? 'Draft preview'
                    : document?.approved
                      ? 'Approved'
                      : 'In review'}
                </span>
              </div>
            )}
            {activeTab?.kind === 'document' && (
              <>
                <span
                  className={`document-save-status ${documentToolbar.saveStatus === 'Save failed' ? 'save-error' : ''}`}
                  role="status"
                >
                  {document?.draft ? 'Read-only preview' : documentToolbar.saveStatus}
                </span>
                <button
                  className={`annotate-tool ${documentToolbar.areaMode ? 'active' : ''}`}
                  aria-label="Annotate document"
                  aria-pressed={documentToolbar.areaMode}
                  disabled={busy || !documentToolbar.canAnnotate || document?.draft}
                  onClick={() =>
                    void transition(async () => {
                      frame.current?.contentWindow?.postMessage(
                        { type: 'projector-toggle-annotate' },
                        'projector://document',
                      );
                    })
                  }
                >
                  Annotate
                </button>
              </>
            )}
            {activeBrowser && <span className="toolbar-divider" aria-hidden="true" />}
            {activeBrowser && (
              <div className="browser-toolbar">
                <button
                  aria-label="Back"
                  disabled={!activeBrowser.canGoBack}
                  onClick={() =>
                    void transition(() =>
                      invoke('browserCommand', { tabId: activeBrowser.id, action: 'back' }),
                    )
                  }
                >
                  <Icon name="back" />
                </button>
                <button
                  aria-label="Forward"
                  disabled={!activeBrowser.canGoForward}
                  onClick={() =>
                    void transition(() =>
                      invoke('browserCommand', { tabId: activeBrowser.id, action: 'forward' }),
                    )
                  }
                >
                  <Icon name="forward" />
                </button>
                <button
                  aria-label={activeBrowser.loading ? 'Stop' : 'Reload'}
                  onClick={() =>
                    void transition(() =>
                      invoke('browserCommand', {
                        tabId: activeBrowser.id,
                        action: activeBrowser.loading ? 'stop' : 'reload',
                      }),
                    )
                  }
                >
                  <Icon name={activeBrowser.loading ? 'stop' : 'refresh'} />
                </button>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void transition(() =>
                      invoke('browserCommand', {
                        tabId: activeBrowser.id,
                        action: 'navigate',
                        url,
                      }),
                    );
                  }}
                >
                  <input
                    aria-label="Browser address"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                </form>
                <select
                  aria-label="Browser zoom"
                  title="Browser zoom · select 100% to reset"
                  value={activeBrowser.zoomFactor ?? 1}
                  onChange={(event) => {
                    const zoomFactor = Number(event.currentTarget.value);
                    void transition(() =>
                      invoke('browserCommand', {
                        tabId: activeBrowser.id,
                        action: 'zoom',
                        zoomFactor,
                      }),
                    );
                  }}
                >
                  {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((factor) => (
                    <option key={factor} value={factor}>
                      {Math.round(factor * 100) + '%'}
                    </option>
                  ))}
                </select>
                <button
                  aria-label="Open page in external browser"
                  title="Open externally · sign-in remains in that browser"
                  onClick={() =>
                    void action(() =>
                      invoke('browserCommand', { tabId: activeBrowser.id, action: 'external' }),
                    )
                  }
                >
                  <Icon name="external" />
                </button>

                <button
                  className={browser.annotating ? 'active' : ''}
                  aria-label="Annotate browser"
                  aria-pressed={browser.annotating}
                  onClick={() =>
                    void action(() =>
                      invoke('browserCommand', { tabId: activeBrowser.id, action: 'annotate' }),
                    )
                  }
                >
                  Annotate
                </button>
              </div>
            )}
          </header>
        )}
        {waiting && (
          <div className="runtime-notice" role="status">
            Waiting for local storage. The operation may complete; do not repeat it until its result
            is reconciled.
          </div>
        )}
        {runtimeNotice && (
          <div className="runtime-notice" role="status">
            <span>
              Closing this window keeps the local runtime running. Use Quit Projector to stop it.
            </span>
            <button
              onClick={() =>
                void action(async () => {
                  await invoke('dismissRuntimeNotice');
                  setRuntimeNotice(false);
                })
              }
            >
              Got it
            </button>
          </div>
        )}
        {error && (
          <div role="alert" className="error-banner">
            {error}
            {retryTransition && (
              <>
                <button onClick={() => void retryTransition()}>Retry</button>
                <button
                  onClick={() => {
                    setRetryTransition(null);
                    setError('');
                  }}
                >
                  Cancel
                </button>
              </>
            )}
            <button onClick={() => setError('')} aria-label="Dismiss error">
<Icon name="close" />
</button>
          </div>
        )}
        {application?.metadataPending && !settingsOpen && (
          <div className="runtime-notice" role="status">
            Local workspace storage needs confirmation. Retry confirms the existing write and does
            not repeat the action.
            <button disabled={busy} onClick={() => void confirmWorkspaceWrite()}>
              Confirm local write
            </button>
          </div>
        )}
        {projectOverview ? (
          <ProjectDashboard
            project={snapshot.projects.find(item => item.id === sessionWorkspace?.projectId)}
            plans={snapshot.artifacts.filter(plan => plan.projectId === sessionWorkspace?.projectId)}
            sessions={(application?.harnesses.sessions ?? []).filter(session => session.projectId === sessionWorkspace?.projectId).sort(pinOrder)}
            terminals={(application?.terminals ?? []).filter(record => record.projectId === sessionWorkspace?.projectId)}
            busy={busy} showArchived={showArchivedPlans} onShowArchived={setShowArchivedPlans}
            onOpenPlan={plan => void openPlan(plan, planRevision(plan))}
            onPlanMenu={plan => void openPlanMenu(plan)}
            onArchive={plan => void archivePlan(plan, !plan.archived)}
            onSession={session => void applicationCommand('select', { sessionId: session.id, key: undefined })}
            onNewTerminal={() => { setBottomFocused(true); void applicationCommand('newTerminal', { area: 'bottom', operationId: crypto.randomUUID() }); }}
            onTerminal={record => void openProjectTerminal(record)}
            onWorkspace={() => void applicationCommand('select', { sessionId: null })}
          />
        ) : appMode ? (
          <div className="session-workspace-content">
            {applicationTab ? (
              <WorkspaceSplit
                key={applicationTab.id}
                node={applicationTab.root}
                activePaneId={sessionWorkspace?.activePaneId ?? null}
                renderPane={renderApplicationPane}
                onRatio={(paneId, ratio) => applicationCommand('ratio', { paneId, ratio }, false)}
                onResizeMode={(active) => {
                  if (nativeFrames.current.size)
                    suspendBrowser('split', active);
                }}
              />
            ) : selectedSession ? (
              renderSessionHome(selectedSession.id)
            ) : sessionWorkspace?.sessionId && !application?.harnesses.error ? (
              renderSessionHome(sessionWorkspace.sessionId)
            ) : (
              <div className="new-tab-home">
                <h2>No open tabs</h2>
                <p className="muted">Open a plan from the project overview or start a project terminal.</p>
                {lastPlan && (
                  <>
                    <button onClick={() => void openPlan(lastPlan, planRevision(lastPlan))}>
                      Open plan
                    </button>
                    <button
                      onClick={() =>
                        void applicationCommand('openHome', { artifactId: lastPlan.id })
                      }
                    >
                      New tab
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        ) : selected ? (
          <>
            {activeBrowser ? (
              <>
                {activeBrowser.error && (
                  <div role="alert" className="error-banner">
                    {activeBrowser.error}
                  </div>
                )}
                {activeBrowser.loading && <small>Loading…</small>}
                <div ref={browserArea} className="browser-area" />
              </>
            ) : activeTab?.kind === 'home' ? (
              <div className="new-tab-home">
                <h2>New tab</h2>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void transition(() =>
                      invoke('workspaceCommand', {
                        artifactId: selected.artifactId,
                        action: 'open',
                        tabId: activeTab.id,
                        url,
                      }),
                    );
                  }}
                >
                  <input
                    autoFocus
                    ref={homeAddress}
                    aria-label="New tab address"
                    placeholder="Enter an HTTP or HTTPS URL"
                    value={url}
                    onChange={(e) => updateHomeAddress(e.target.value)}
                  />
                  <button className="primary" disabled={busy}>
                    Open
                  </button>
                </form>
              </div>
            ) : activeTab?.kind === 'document' &&
              !document?.revision &&
              !document?.source &&
              !document?.preview &&
              artifact ? (
              <div className="new-tab-home empty-plan-home">
                <h2>Waiting for your agent</h2>
                <p className="muted">
                  This plan is ready as a private workspace. Ask your agent to write and publish its
                  first document.
                </p>
                <button className="primary" onClick={() => void copy(agentMessage(artifact))}>
                  {copiedText === agentMessage(artifact) ? 'Copied' : 'Copy message for agent'}
                </button>
                <button onClick={() => void tabCommand('new')}>New tab</button>
              </div>
            ) : activeTab?.kind === 'document' ? (
              <iframe
                ref={frame}
                sandbox="allow-scripts allow-same-origin"
                className="document-frame"
                title="Projector document"
                src={surfaceUrl}
                onLoad={() => {
                  surfaceReady.current = true;
                  sendJump();
                }}
              />
            ) : (
              <div className="new-tab-home">
                <h2>No open tabs</h2>
                <button
                  onClick={() =>
                    void transition(() =>
                      invoke('openArtifact', {
                        artifactId: selected.artifactId,
                        revisionId: selected.revisionId,
                      }),
                    )
                  }
                >
                  Open plan
                </button>
                <button onClick={() => void tabCommand('new')}>New tab</button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="welcome">
              <div className="welcome-symbol">◇</div>
              <h2>Make decisions before implementation</h2>
              <p>
                Connect your agent through MCP, publish a plan, and save answers and annotations for
                the same session.
              </p>
              <button
                className="primary"
                onClick={() => void action(() => invoke('chooseProject'))}
              >
                Open project folder
              </button>
            </div>
          </>
        )}
        {appMode && bottom?.visible && (
          <section
            className="project-terminal-panel"
            style={{ height: bottomHeightPreview ?? bottom.height }}
            aria-label="Project terminals"
          >
            <div
              className="bottom-resizer"
              role="separator"
              tabIndex={0}
              aria-orientation="horizontal"
              aria-label="Resize project terminals"
              aria-valuemin={120}
              aria-valuemax={800}
              aria-valuenow={bottom.height}
              onPointerDown={(event) => {
                bottomDrag.current = {
                  pointerId: event.pointerId,
                  startY: event.clientY,
                  startHeight: bottom.height,
                  height: bottom.height,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
                event.preventDefault();
              }}
              onPointerMove={(event) => {
                const drag = bottomDrag.current;
                if (!drag || drag.pointerId !== event.pointerId) return;
                drag.height = Math.max(
                  120,
                  Math.min(800, Math.round(drag.startHeight + drag.startY - event.clientY)),
                );
                setBottomHeightPreview(drag.height);
              }}
              onPointerUp={(event) => {
                const drag = bottomDrag.current;
                bottomDrag.current = null;
                event.currentTarget.releasePointerCapture(event.pointerId);
                if (drag)
                  void applicationCommand('bottomHeight', { height: drag.height }, false).finally(
                    () => setBottomHeightPreview(null),
                  );
              }}
              onPointerCancel={() => {
                bottomDrag.current = null;
                setBottomHeightPreview(null);
              }}
              onKeyDown={(event) => {
                if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
                  event.preventDefault();
                  void applicationCommand(
                    'bottomHeight',
                    {
                      height: Math.max(
                        120,
                        Math.min(800, bottom.height + (event.key === 'ArrowUp' ? 20 : -20)),
                      ),
                    },
                    false,
                  );
                }
              }}
            />
            <nav className="bottom-terminal-tabs" role="tablist" aria-label="Project terminal tabs">
              {bottom.tabs.map((id) => {
                const record = application?.terminals.find((record) => record.id === id);
                return (
                  <div className={bottom.activeTerminalId === id ? 'active' : ''} key={id}>
                    <button
                      role="tab"
                      aria-selected={bottom.activeTerminalId === id}
                      onClick={() => {
                        setBottomFocused(true);
                        void applicationCommand('bottomSelect', { terminalId: id });
                      }}
                    >
                      {record?.title ?? 'Terminal'}
                    </button>
                    <button
                      aria-label={`Close ${record?.title ?? 'project terminal'} view`}
                      onClick={() => void applicationCommand('bottomClose', { terminalId: id })}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                );
              })}
              <button
                aria-label="New project terminal"
                disabled={busy}
                onClick={() => {
                  setBottomFocused(true);
                  void applicationCommand('newTerminal', {
                    area: 'bottom',
                    operationId: crypto.randomUUID(),
                  });
                }}
              >
                <Icon name="plus" />
              </button>
              <button
                className="bottom-hide"
                aria-label="Hide project terminals"
                onClick={() => void applicationCommand('bottomToggle')}
              >
                <Icon name="down" />
              </button>
            </nav>
            {application?.terminals.find((record) => record.id === bottom.activeTerminalId) ? (
              <TerminalPane
                record={application.terminals.find(
                  (record) => record.id === bottom.activeTerminalId,
                )!}
                viewId={`bottom-${sessionWorkspace?.projectId}-${bottom.activeTerminalId}`}
                active={
                  bottomFocused &&
                  !settingsOpen &&
                  !guideOpen &&
                  !setup &&
                  !renaming &&
                  !sessionMetadata
                }
                settings={currentSettings}
                bridge={bridge}
                onFocus={() => setBottomFocused(true)}
                onActivateForDrop={async () => {
                  if (settingsOpen || guideOpen || setup || renaming || sessionMetadata || busy) return false;
                  setBottomFocused(true); return true;
                }}
                onChange={() => void reload()}
              />
            ) : (
              <div className="new-tab-home">
                <button
                  onClick={() =>
                    void applicationCommand('newTerminal', {
                      area: 'bottom',
                      operationId: crypto.randomUUID(),
                    })
                  }
                >
                  New project terminal
                </button>
              </div>
            )}
          </section>
        )}
      </main>
      <div className="feedback-viewport">
        <aside className="feedback-panel" ref={rightSidebarContent}>
          <h2>Feedback</h2>
          <p className="muted">Working changes stay private until Save.</p>
          {artifact && (
            <details className="artifact-properties">
              <summary>Artifact properties</summary>
              <p className="muted">
                Some sign-in providers block embedded browsers. Open the page externally;
                authentication is not imported back.
              </p>
              <button
                className="secondary full"
                onClick={() =>
                  void transition(() =>
                    invoke('browserClearProfile', { projectId: artifact.projectId }),
                  )
                }
              >
                Clear project browser profile
              </button>
              {artifact.originSession ? (
                <>
                  <small>Origin: {artifact.originSession.harness} · availability unverified</small>
                  <button
                    className="secondary full"
                    onClick={() => {
                      if (artifact.originSession)
                        void copy(`codex://threads/${artifact.originSession.sessionId}`);
                    }}
                  >
                    Copy session link
                  </button>
                </>
              ) : (
                <small>No agent session attached</small>
              )}
            </details>
          )}
          {document?.migrationSummary && artifact && (artifact.revisions?.length ?? 0) > 1 && (
            <details className="migration-summary">
              <summary>Answers in this version</summary>
              {(['retained', 'added', 'requiresResponse', 'removed'] as const).map((key) => (
                <p key={key}>
                  <strong>
                    {
                      {
                        retained: 'Retained',
                        added: 'New',
                        requiresResponse: 'Requires response',
                        removed: 'Removed',
                      }[key]
                    }
                  </strong>
                  : {document.migrationSummary![key].join(', ') || 'None'}
                </p>
              ))}
              <small>
                Authored defaults are not confirmed answers. Previous versions retain their state.
              </small>
            </details>
          )}
          {(browser.downloads?.length ?? 0) > 0 && (
            <details className="package-history">
              <summary>Downloads</summary>
              {browser.downloads?.map((download) => (
                <p key={download.id} role="status">
                  {download.filename} · {download.status}
                </p>
              ))}
            </details>
          )}
          <div className="section-label spaced">
            ANNOTATIONS <span>{annotations.length}</span>
          </div>
          <div className="annotations">
            {annotations.length === 0 ? (
              <div className="empty-note">
                Select a passage, then choose Annotate. Answers are autosaved privately.
              </div>
            ) : (
              annotations.map((annotation, i) => (
                <article className="annotation" key={annotation.id}>
                  <div className="annotation-heading">
                    <button className="annotation-jump" onClick={() => void jumpTo(annotation)}>
                      <AnnotationBadge number={annotation.number ?? i + 1} />
                      <blockquote>{annotation.quote || 'Selected area'}</blockquote>
                    </button>
                    <div className="annotation-actions">
                      <button
                        disabled={busy || documentEditing || Boolean(editing) || browser.annotating}
                        title="Edit annotation"
                        aria-label={`Edit annotation ${i + 1}`}
                        onClick={() => {
                          restoredEditing.current = annotation.id;
                          void action(async () => {
                            if (annotation.kind !== 'browser-area')
                              await invoke('openArtifact', {
                                artifactId: annotation.artifactId,
                                revisionId: annotation.revisionId,
                              });
                            await invoke('saveEditor', {
                              artifactId: annotation.artifactId,
                              revisionId: annotation.revisionId,
                              editor: {
                                selection: annotationSelection(annotation),
                                comment: annotation.comment,
                                annotationId: annotation.id,
                              },
                            });
                            editWriteError.current = null;
                            await invoke('editing', { active: true, scope: 'operator' });
                            setEditing(annotation);
                            setComment(annotation.comment);
                          });
                        }}
                      >
                        <Icon name="edit" />
                      </button>
                      <button
                        disabled={busy || documentEditing || Boolean(editing) || browser.annotating}
                        title="Delete annotation"
                        aria-label={`Delete annotation ${i + 1}`}
                        onClick={() =>
                          void action(() =>
                            invoke('deleteAnnotation', { annotationId: annotation.id }),
                          )
                        }
                      >
                        <Icon name="delete" />
                      </button>
                    </div>
                  </div>
                  {editing?.id === annotation.id ? (
                    <CommentComposer
                      ref={editComposer}
                      editing
                      label="Edit annotation"
                      saveLabel="Save comment"
                      value={comment}
                      disabled={busy && !transitioning.current}
                      onChange={(value) => persistEdit(annotation, value)}
                      onSave={() => finishEdit(annotation, 'save')}
                      onCancel={() => finishEdit(annotation, 'cancel')}
                      onDelete={() => finishEdit(annotation, 'delete')}
                      onError={(error) => setError(message(error))}
                    />
                  ) : (
                    <p onClick={() => void jumpTo(annotation)}>{annotation.comment}</p>
                  )}
                </article>
              ))
            )}
          </div>
          <div className="submit-area">
            <button
              className="primary full"
              disabled={
                busy ||
                savingCount > 0 ||
                Array.from(failedAutosaves).some((key) =>
                  key.startsWith(`${selected?.artifactId}:`),
                ) ||
                documentEditing ||
                documentPreview ||
                browser.annotating ||
                Boolean(editing) ||
                !selected?.revisionId
              }
              onClick={() =>
                void action(async () => {
                  const key = JSON.stringify(selected);
                  const intent = saveIntents.current.get(key) ?? {
                    ...selected,
                    operationId: crypto.randomUUID(),
                    expectedLatestSavedStateId: document?.latestSavedStateId ?? null,
                  };
                  saveIntents.current.set(key, intent);
                  try {
                    const result = await invoke<{ id: string; notification: string }>(
                      'saveState',
                      intent,
                    );
                    saveIntents.current.delete(key);
                    setNotification(result.notification);
                    if (selected)
                      setNotificationState({
                        artifactId: selected.artifactId,
                        savedStateId: result.id,
                      });
                  } catch (e) {
                    if (/STATE_CONFLICT|INVALID_STATE|UNFINISHED_ANNOTATION/.test(message(e)))
                      saveIntents.current.delete(key);
                    throw e;
                  }
                })
              }
            >
              {busy
                ? 'Working…'
                : savingCount > 0
                  ? 'Autosaving…'
                  : saveIntents.current.has(JSON.stringify(selected))
                    ? 'Retry Save'
                    : 'Save'}
            </button>
            <small>
              {projectOverview ? (
                'Open a plan to review its answers and annotations.'
              ) : !artifact?.latestRevision ? (
                'Save and approval become available after the agent publishes the first document. Your workspace is autosaved privately.'
              ) : (
                <>
                  {document?.dirty ? 'Unsaved working changes' : 'Saved state is unchanged'} · Save
                  keeps annotations and creates an immutable snapshot.
                </>
              )}
            </small>
            {notification && (
              <div className="notification">
                <label className="handoff-session-label">
                  Target session
                  <select
                    aria-label="Target Codex session"
                    value={handoffSessionId}
                    onChange={(event) => setHandoffSessionId(event.target.value)}
                  >
                    <option value="">Copy only</option>
                    {application?.harnesses.sessions
                      .filter((session) => session.projectId === artifact?.projectId)
                      .map((session) => (
                        <option
                          key={session.id}
                          value={session.id}
                          disabled={!session.terminalId || session.processState !== 'running'}
                        >
                          {session.title || session.id}
                          {session.terminalId && session.processState === 'running'
                            ? ''
                            : ' · Resume first'}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  className="secondary full"
                  onClick={() => void transition(() => copyUpdate(notification))}
                >
                  {copiedText === notification ? 'Copied' : 'Copy update message'}
                </button>
                <small>Saved · notify your agent manually</small>
              </div>
            )}
            {selected?.revisionId && (
              <button
                className="subtle full"
                disabled={
                  busy ||
                  savingCount > 0 ||
                  documentEditing ||
                  documentPreview ||
                  browser.annotating ||
                  Array.from(failedAutosaves).some((key) =>
                    key.startsWith(`${selected?.artifactId}:`),
                  ) ||
                  Boolean(editing) ||
                  (!document?.approved && document?.dirty)
                }
                onClick={() =>
                  void action(async () => {
                    if (document?.approved) {
                      if (
                        revokeIntent.current?.artifactId !== selected.artifactId ||
                        revokeIntent.current?.revisionId !== selected.revisionId
                      ) {
                        revokeIntent.current = { ...selected, operationId: crypto.randomUUID() };
                      }
                      await invoke('revokeApproval', revokeIntent.current);
                      revokeIntent.current = null;
                    } else await invoke('approve', selected ?? {});
                  })
                }
              >
                {document?.approved ? 'Revoke approval' : 'Approve this version'}
              </button>
            )}
            <small>Approval records agreement. It does not authorize implementation.</small>
          </div>
          {(snapshot.savedStates ?? []).filter((state) => state.artifactId === artifact?.id)
            .length > 0 && (
            <details className="package-history">
              <summary>Saved states</summary>
              {snapshot.savedStates
                ?.filter((state) => state.artifactId === artifact?.id)
                .map((state) => (
                  <div key={state.id}>
                    <small>{new Date(state.createdAt).toLocaleString()}</small>
                    {state.notification && (
                      <button
                        onClick={() =>
                          void transition(() =>
                            copyUpdate(
                              state.notification ?? '',
                              state.artifactId
                                ? { artifactId: state.artifactId, savedStateId: state.id }
                                : null,
                            ),
                          )
                        }
                      >
                        Copy update message
                      </button>
                    )}
                  </div>
                ))}
            </details>
          )}
          {snapshot.packages.filter((p) => !p.projectId || p.projectId === projectId).length >
            0 && (
            <details className="package-history">
              <summary>Legacy submitted packages</summary>
              {snapshot.packages
                .filter((p) => !p.projectId || p.projectId === projectId)
                .map((p) => (
                  <div key={p.id}>
                    <small>{new Date(p.createdAt).toLocaleString()}</small>
                    {p.notification && (
                      <button onClick={() => void copy(p.notification ?? '')}>
                        Copy legacy notification
                      </button>
                    )}
                  </div>
                ))}
            </details>
          )}
        </aside>
      </div>
      {renaming && (
        <div
          className="modal-backdrop"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              closeRename();
            }
          }}
        >
          <section
            className="modal rename-plan-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Rename plan"
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void saveRename();
              }}
            >
              <h2>Rename plan</h2>
              {renameError && (
                <p role="alert" className="error-banner">
                  {renameError}
                </p>
              )}
              <label htmlFor="plan-name">Plan name</label>
              <input
                id="plan-name"
                disabled={renameBusy}
                autoFocus
                value={renaming.title}
                onChange={(event) => setRenaming({ ...renaming, title: event.target.value })}
              />
              <div className="rename-plan-actions">
                <button type="button" disabled={renameBusy} onClick={closeRename}>
                  Cancel
                </button>
                <button
                  className="primary"
                  type="submit"
                  disabled={renameBusy || !renaming.title.trim()}
                >
                  Save
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {settingsOpen && (
        <ApplicationSettings
          settings={currentSettings}
          harnesses={
            application?.harnesses ?? {
              sessions: [],
              compatibility: null,
              error: null,
              mcpStartup: [],
            }
          }
          onClose={() => setSettingsOpen(false)}
          onSave={async (settings: Settings) => {
            try {
              await invoke('applicationSettings', settings as unknown as Record<string, unknown>);
            } finally {
              await reload();
            }
          }}
          onCheck={async () => {
            await invoke('harnessCheck');
            await reload();
          }}
          onShortcutCapture={shortcutCapture}
          metadataPending={Boolean(application?.metadataPending)}
          onConfirm={async () => {
            await invoke('confirmWorkspaceWrite');
            await reload();
          }}
        />
      )}
      {sessionMetadata && (
        <div
          className="modal-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setSessionMetadata(null);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Codex session metadata"
          >
            <div className="modal-heading">
              <h2>{sessionMetadata.title || 'Codex session'}</h2>
              <button onClick={() => setSessionMetadata(null)}>Close</button>
            </div>
            <dl>
              <dt>Session ID</dt>
              <dd>{sessionMetadata.id}</dd>
              <dt>Working folder</dt>
              <dd>{sessionMetadata.cwd}</dd>
              <dt>Process</dt>
              <dd>
                {sessionMetadata.processState === 'unknown'
                  ? 'Unknown'
                  : sessionMetadata.processState}
              </dd>
            </dl>
            <p className="muted">
              Open this session's project folder in Projector to enable explicit Resume.
            </p>
          </section>
        </div>
      )}
      {guideOpen && <GuideViewer load={guideLoad} close={closeInformation} />}
      {setup && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeInformation();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              closeInformation();
            }
          }}
        >
          <section className="modal" role="dialog" aria-modal="true" aria-label="MCP connection">
            <div className="modal-heading">
              <h2>Connect Projector through MCP</h2>
              <button className="subtle" onClick={closeInformation}>
                Close
              </button>
            </div>
            <p>Copy the setup prompt and paste it into your agent. Keep Projector running.</p>
            <button className="primary" onClick={() => void copy(setup.prompt)}>
              {copiedText === setup.prompt ? 'Copied' : 'Copy setup prompt'}
            </button>
            <p className="muted">
              The prompt configures your user-level MCP connection across projects. Keep personal
              paths out of project configuration. You may need to reconnect MCP before tools appear
              in this session.
            </p>
            <details>
              <summary>Preview setup prompt</summary>
              <pre>{setup.prompt}</pre>
            </details>
            <details>
              <summary>Connection details and manual configuration</summary>
              <p className="muted">
                {setup.mode === 'packaged'
                  ? 'Packaged application — uses the bundled MCP helper and Node runtime.'
                  : setup.mode === 'development'
                    ? 'Development — uses the source bridge and your Node.js installation.'
                    : 'Production build from source — uses the source bridge and your Node.js installation.'}
              </p>
              <p>
                MCP calls reach this application through an authenticated loopback HTTP runtime.
              </p>
              <label>Runtime descriptor</label>
              <pre>{setup.descriptorPath}</pre>
              <label>Stdio command</label>
              <pre>{setup.command}</pre>
              <label>Configuration</label>
              <pre>{setup.config}</pre>
              <button className="secondary" onClick={() => void copy(setup.config)}>
                {copiedText === setup.config ? 'Copied' : 'Copy configuration'}
              </button>
            </details>
            <p className="muted">
              Projector does not edit your configuration. The prompt asks your agent to configure
              only this MCP connection.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function AnnotationBadge({ number }: { number: number }): React.JSX.Element {
  const { cx, cy, path } = markerGeometry({ x: 3.75, y: 24.25 }, { width: 28, height: 28 });
  return (
    <svg className="annotation-number" viewBox="0 0 28 28" aria-hidden="true">
      <path d={path} fill="#4263da" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
      <text
        x={cx}
        y={cy}
        dominantBaseline="central"
        textAnchor="middle"
        fontSize="10"
        fontWeight="600"
        fontFamily="sans-serif"
        fill="white"
      >
        {number}
      </text>
    </svg>
  );
}

function Diagram({ source }: { source: string }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'neutral',
      suppressErrorRendering: true,
    });
    void mermaid
      .render(`diagram-${crypto.randomUUID()}`, source)
      .then((result) => {
        if (active && container.current) container.current.innerHTML = result.svg;
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [source]);
  return error ? (
    <div className="diagram-error">
      Diagram unavailable: {error}
      <pre>{source}</pre>
    </div>
  ) : (
    <div ref={container} className="diagram" />
  );
}

function Widget({
  definition,
  value,
  update,
  readOnly = false,
}: {
  definition: WidgetDefinition;
  value: Value | undefined;
  update: (id: string, value: Value) => void;
  readOnly?: boolean;
}): React.JSX.Element {
  const options = (definition.options ?? []).map((option) =>
    typeof option === 'string' ? { value: option, label: option } : option,
  );
  const current =
    value ?? definition.defaultValue ?? (definition.kind.toLowerCase().includes('check') ? [] : '');
  return (
    <section className="widget" data-widget-id={definition.id}>
      <div className="widget-label">{definition.meaning}</div>
      {definition.kind.toLowerCase().includes('choice') ? (
        <div className="choices">
          {options.map((option) => (
            <label key={option.value} className={current === option.value ? 'selected' : ''}>
              <input
                type="radio"
                disabled={readOnly}
                name={definition.id}
                value={option.value}
                checked={current === option.value}
                onChange={() => update(definition.id, option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      ) : definition.kind.toLowerCase().includes('check') ? (
        <div className="checklist">
          {options.map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                disabled={readOnly}
                checked={Array.isArray(current) && current.includes(option.value)}
                onChange={(event) => {
                  const values = Array.isArray(current) ? current : [];
                  update(
                    definition.id,
                    event.target.checked
                      ? [...values, option.value]
                      : values.filter((item) => item !== option.value),
                  );
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      ) : (
        <textarea
          aria-label={definition.meaning}
          disabled={readOnly}
          value={typeof current === 'string' ? current : ''}
          placeholder="Your answer…"
          onChange={(event) => update(definition.id, event.target.value)}
        />
      )}
      <small>Your answer is private until Save.</small>
    </section>
  );
}

function detailDefaults(blocks: DocumentNode[]): Record<string, boolean> {
  const entries: Record<string, boolean> = {};
  function walk(node: DocumentNode): void {
    if ((node.type === 'Details' || node.type === 'details') && node.id) entries[node.id] = false;
    for (const child of node.children ?? []) walk(child);
  }
  for (const block of blocks) walk(block);
  return entries;
}
function DocumentSurface(): React.JSX.Element {
  const query = new URLSearchParams(window.location.search);
  const artifactId = query.get('artifactId') ?? '';
  const revisionId = query.get('revisionId') || null;
  const paneId = query.get('paneId');
  const scrollRestored = useRef(false);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [data, setData] = useState<DocumentResult | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let shortcuts = DEFAULT_SETTINGS.shortcuts;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        event.origin !== documentShellOrigin() ||
        event.data?.type !== 'projector-shortcuts'
      )
        return;
      const candidate = event.data.shortcuts;
      if (!candidate || typeof candidate !== 'object') return;
      const keys = Object.keys(DEFAULT_SETTINGS.shortcuts) as ShortcutAction[];
      if (keys.every((key) => candidate[key] === null || typeof candidate[key] === 'string'))
        shortcuts = candidate;
    };
    const keydown = (event: KeyboardEvent) => {
      const action = shortcutAction(event, shortcuts);
      if (!action) return;
      event.preventDefault();
      window.parent.postMessage({ type: 'projector-shortcut', action }, documentShellOrigin());
    };
    const focus = () =>
      window.parent.postMessage({ type: 'projector-focus' }, documentShellOrigin());
    window.addEventListener('message', receive);
    window.addEventListener('keydown', keydown);
    window.addEventListener('pointerdown', focus, true);
    window.addEventListener('focus', focus);
    return () => {
      window.removeEventListener('message', receive);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('pointerdown', focus, true);
      window.removeEventListener('focus', focus);
    };
  }, []);
  const [saveStatus, setSaveStatus] = useState('Saved locally');
  const [candidate, setCandidate] = useState<SelectionData | null>(null);
  const [selection, setSelection] = useState<SelectionData | null>(null);
  const [popover, setPopover] = useState({ x: 20, y: 80 });
  const popoverElement = useRef<HTMLDivElement>(null);
  const commentAnchor = useRef<{ x: number; y: number } | null>(null);
  const [comment, setComment] = useState('');
  const [highlights, setHighlights] = useState<
    {
      id: string;
      number: number;
      pointer?: { x: number; y: number };
      markerVisible: boolean;
      rects: { x: number; y: number; width: number; height: number }[];
    }[]
  >([]);
  const [focused, setFocused] = useState('');
  const [details, setDetails] = useState<Record<string, boolean>>({});
  const [previewState, setPreviewState] = useState<AnnotationState | null>(null);
  const [contextPending, setContextPending] = useState(false);
  useEffect(() => {
    const element = popoverElement.current;
    if (!selection || !element || !commentAnchor.current) return;
    const place = () => {
      if (!commentAnchor.current) return;
      const bounds = element.getBoundingClientRect();
      setPopover(
        commentPosition(commentAnchor.current, { width: innerWidth, height: innerHeight }, bounds),
      );
    };
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener('resize', place);
    place();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [selection, contextPending]);
  const contextWork = useRef(Promise.resolve());
  function beginContextWrite(): () => void {
    let complete!: () => void;
    contextWork.current = new Promise<void>((resolve) => {
      complete = resolve;
    });
    setContextPending(true);
    return () => {
      setContextPending(false);
      complete();
    };
  }
  const [hovered, setHovered] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
    blockId: string;
  } | null>(null);
  const hoverRef = useRef<typeof hovered>(null);
  const keyboardAreaIndex = useRef(-1);
  const gesture = useRef<{
    start: { x: number; y: number };
    end: { x: number; y: number };
    hover: typeof hovered;
  } | null>(null);
  const [areaMode, setAreaMode] = useState(false);
  useEffect(() => {
    const status = () =>
      window.parent.postMessage(
        {
          type: 'projector-document-status',
          saveStatus: data?.draft ? 'Read-only preview' : saveStatus,
          areaMode,
          canAnnotate: Boolean(
            data && !data.draft && !previewState && !selection && !contextPending,
          ),
        },
        documentShellOrigin(),
      );
    status();
    const command = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== documentShellOrigin()) return;
      if (event.data?.type === 'projector-document-status-request') status();
      if (
        event.data?.type === 'projector-toggle-annotate' &&
        data &&
        !data.draft &&
        !previewState &&
        !selection &&
        !contextPending
      )
        setAreaMode((value) => !value);
    };
    window.addEventListener('message', command);
    return () => window.removeEventListener('message', command);
  }, [data, saveStatus, areaMode, previewState, selection, contextPending]);
  const [areaStart, setAreaStart] = useState<{ x: number; y: number } | null>(null);
  const [areaEnd, setAreaEnd] = useState<{ x: number; y: number } | null>(null);
  const composer = useRef<CommentComposerHandle>(null);
  const saves = useRef(Promise.resolve());
  const failedTasks = useRef(new Map<string, () => Promise<unknown>>());
  const generation = useRef(0);
  const restored = useRef(false);
  const article = useRef<HTMLElement>(null);
  const pendingJump = useRef<Annotation | null>(null);
  const parsed = data?.revision ?? data?.preview;
  const readView = useCallback(
    async (isCurrent: () => boolean) => {
      const writeToken = generation.current;
      const next = await invoke<DocumentResult>('getDocument', { artifactId, revisionId });
      if (!isCurrent() || writeToken !== generation.current || failedTasks.current.size) return;
      setData(next);
      setDetails({
        ...detailDefaults((next.revision ?? next.preview)?.blocks ?? []),
        ...next.view?.details,
      });
      if (!restored.current) {
        restored.current = true;
        if (next.editor && !next.editor.annotationId) {
          setSelection(next.editor.selection);
          setComment(next.editor.comment);
          void invoke('editing', { active: true });
        }
      }
    },
    [artifactId, revisionId],
  );
  const refreshQueue = useMemo(
    () => new RefreshQueue(readView, (error) => setError(message(error))),
    [readView],
  );
  const reload = useCallback(() => refreshQueue.request(), [refreshQueue]);
  const queue = useCallback(
    (task: () => Promise<unknown>, key = 'editor'): Promise<void> => {
      const resume = refreshQueue.pause();
      refreshQueue.invalidate();
      const token = ++generation.current;
      saves.current = saves.current
        .catch(() => undefined)
        .then(async () => {
          try {
            await task();
            failedTasks.current.delete(key);
            if (token === generation.current) {
              setSaveStatus('Saved locally');
            }
          } catch (e) {
            setError(message(e));
            failedTasks.current.set(key, task);
            setSaveStatus('Save failed');
          } finally {
            resume();
          }
        });
      return saves.current;
    },
    [refreshQueue],
  );
  useEffect(() => {
    if (!paneId || !data || scrollRestored.current) return;
    const id = requestAnimationFrame(() => {
      window.scrollTo({ top: data.scrollTop ?? 0, behavior: 'instant' });
      scrollRestored.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, [paneId, data]);
  useEffect(() => {
    if (!paneId) return;
    const scroll = () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
      scrollTimer.current = setTimeout(() => {
        scrollTimer.current = null;
        void queue(
          () => invoke('setViewState', { artifactId, revisionId, scrollTop: window.scrollY }),
          'scroll',
        );
      }, 180);
    };
    window.addEventListener('scroll', scroll);
    return () => {
      window.removeEventListener('scroll', scroll);
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    };
  }, [paneId, artifactId, revisionId, queue]);
  useEffect(() => {
    refreshQueue.invalidate();
    return bridge.onRefresh(() => refreshQueue.invalidate());
  }, [refreshQueue]);
  useEffect(() => {
    void invoke('previewing', { active: Boolean(previewState) });
  }, [previewState]);
  useEffect(() => {
    if (!contextPending) return;
    const prevent = (event: Event) => event.preventDefault();
    window.addEventListener('wheel', prevent, { passive: false });
    window.addEventListener('touchmove', prevent, { passive: false });
    window.addEventListener('keydown', prevent);
    return () => {
      window.removeEventListener('wheel', prevent);
      window.removeEventListener('touchmove', prevent);
      window.removeEventListener('keydown', prevent);
    };
  }, [contextPending]);
  useEffect(() => {
    if (!areaMode) return;
    keyboardAreaIndex.current = -1;
    window.document.querySelector<HTMLElement>('.area-selection-overlay')?.focus();
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAreaMode(false);
        gesture.current = null;
        setAreaStart(null);
        setAreaEnd(null);
        setHovered(null);
        hoverRef.current = null;
      }
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [areaMode]);
  const displayValues = useMemo(
    () => previewState?.values ?? data?.state.values ?? {},
    [previewState?.values, data?.state.values],
  );
  const displayDetails = previewState?.view.details ?? details;
  const stateMatches = useCallback(
    (context?: AnnotationState): boolean =>
      !context ||
      (canonical(context.values) === canonical(displayValues) &&
        canonical(context.view.details) === canonical(displayDetails)),
    [displayValues, displayDetails],
  );
  const redraw = useCallback(() => {
    if (!article.current) return;
    const root = article.current;
    setHighlights(
      [
        ...(data?.annotations ?? []),
        ...(selection
          ? [
              {
                ...selection,
                id: 'pending-comment',
                artifactId,
                revisionId,
                comment: '',
                number: (data?.annotations.length ?? 0) + 1,
              },
            ]
          : []),
      ]
        .filter(
          (a) =>
            a.revisionId === revisionId &&
            (a.anchor || (a.kind === 'document-area' && Boolean(a.stateContext))) &&
            stateMatches(a.stateContext),
        )
        .map((a, i) => {
          const range = a.anchor ? anchorRange(root, a.anchor) : null;
          const capture = a.capture?.source as
            | {
                rect?: { x: number; y: number; width: number; height: number };
                scroll?: { x: number; y: number };
                pointer?: { x: number; y: number };
                viewport?: { width: number; height: number; deviceScaleFactor: number };
              }
            | undefined;
          const geometryMatches =
            capture?.viewport &&
            Math.abs(capture.viewport.width - window.innerWidth) < 2 &&
            Math.abs(capture.viewport.height - window.innerHeight) < 2 &&
            capture.viewport.deviceScaleFactor === window.devicePixelRatio;
          const area =
            capture?.rect && geometryMatches
              ? [
                  {
                    ...capture.rect,
                    x: capture.rect.x + (capture.scroll?.x ?? 0),
                    y: capture.rect.y + (capture.scroll?.y ?? 0),
                  },
                ]
              : [];
          const rawRects = range
            ? Array.from(range.getClientRects()).map((r) => ({
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
              }))
            : area.map((r) => ({ ...r, x: r.x - window.scrollX, y: r.y - window.scrollY }));
          const last = rawRects.at(-1);
          const pointer =
            area.length && capture?.pointer
              ? {
                  x: capture.pointer.x + (capture.scroll?.x ?? 0) - window.scrollX,
                  y: capture.pointer.y + (capture.scroll?.y ?? 0) - window.scrollY,
                }
              : last
                ? { x: last.x + last.width, y: last.y + last.height / 4 }
                : undefined;
          const markerClip = annotationClip(range?.endContainer ?? root);
          const highlightClip = annotationClip(range?.commonAncestorContainer ?? root);
          return {
            id: a.id,
            number: a.number ?? i + 1,
            pointer: pointer && { x: pointer.x + window.scrollX, y: pointer.y + window.scrollY },
            markerVisible: Boolean(
              pointer &&
              markerClip &&
              pointer.x >= markerClip.left &&
              pointer.x <= markerClip.right &&
              pointer.y >= markerClip.top &&
              pointer.y <= markerClip.bottom,
            ),
            rects: rawRects.flatMap((r) => {
              if (!highlightClip) return [];
              const left = Math.max(r.x, highlightClip.left),
                top = Math.max(r.y, highlightClip.top);
              const right = Math.min(r.x + r.width, highlightClip.right),
                bottom = Math.min(r.y + r.height, highlightClip.bottom);
              return right > left && bottom > top
                ? [
                    {
                      x: left + window.scrollX,
                      y: top + window.scrollY,
                      width: right - left,
                      height: bottom - top,
                    },
                  ]
                : [];
            }),
          };
        }),
    );
  }, [data?.annotations, revisionId, stateMatches, selection, artifactId]);
  useEffect(() => {
    redraw();
    const observer = new ResizeObserver(redraw);
    if (article.current) observer.observe(article.current);
    window.addEventListener('resize', redraw);
    window.addEventListener('scroll', redraw, true);
    article.current?.addEventListener('toggle', redraw, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', redraw);
      window.removeEventListener('scroll', redraw, true);
      article.current?.removeEventListener('toggle', redraw, true);
    };
  }, [redraw, parsed]);
  useEffect(() => {
    function navigate(a: Annotation): void {
      if (a.revisionId !== revisionId || !article.current) return;
      if (
        a.stateContext &&
        !stateMatches(a.stateContext) &&
        canonical(previewState) !== canonical(a.stateContext)
      ) {
        setPreviewState(a.stateContext);
        return;
      }
      const range = a.anchor ? anchorRange(article.current, a.anchor) : null;
      const target =
        range?.startContainer.parentElement ??
        Array.from(article.current.querySelectorAll<HTMLElement>('[data-block-id]')).find(
          (e) => e.dataset.blockId === a.blockId,
        );
      for (
        let parent: HTMLElement | null | undefined = target;
        parent;
        parent = parent.parentElement
      )
        if (parent instanceof HTMLDetailsElement && !a.stateContext) parent.open = true;
      if (a.kind === 'document-area') {
        const capture = a.capture?.source as
          { rect?: { x: number; y: number }; scroll?: { x: number; y: number } } | undefined;
        window.scrollTo({ top: (capture?.rect?.y ?? 0) + (capture?.scroll?.y ?? 0) - 80 });
      } else target?.scrollIntoView({ block: 'center', behavior: 'instant' });
      if (!target && a.kind !== 'document-area') return;
      setFocused(a.id);
      redraw();
      pendingJump.current = null;
      void invoke('annotationNavigated', { artifactId, revisionId, annotationId: a.id });
    }
    function jump(event: MessageEvent): void {
      if (event.source !== window.parent || event.data?.type !== 'projector-jump') return;
      pendingJump.current = event.data.annotation as Annotation;
      navigate(pendingJump.current);
    }
    if (pendingJump.current) navigate(pendingJump.current);
    window.addEventListener('message', jump);
    return () => window.removeEventListener('message', jump);
  }, [revisionId, redraw, stateMatches, previewState]);
  function update(id: string, value: Value): void {
    if (data?.draft || previewState) return;
    setData(
      (previous) =>
        previous && { ...previous, state: { values: { ...previous.state.values, [id]: value } } },
    );
    setSaveStatus('Saving…');
    void queue(() => invoke('setValue', { artifactId, revisionId, widgetId: id, value }), id);
  }
  function captureSelection(): void {
    if (selection || areaMode || data?.draft || previewState || !article.current) return;
    const next = captureTextSelection(article.current);
    setCandidate(next);
    const selected = window.getSelection();
    const rect = selected?.rangeCount ? selected.getRangeAt(0).getBoundingClientRect() : null;
    if (rect)
      setPopover({
        x: Math.max(12, Math.min(rect.x, window.innerWidth - 340)),
        y: Math.min(rect.bottom + 8, window.innerHeight - 260),
      });
  }
  async function annotationContext(): Promise<AnnotationState> {
    await saves.current;
    if (failedTasks.current.size) throw new Error('Retry failed autosave before annotating.');
    const current = { ...detailDefaults(parsed?.blocks ?? []) };
    for (const element of article.current?.querySelectorAll<HTMLDetailsElement>(
      'details[data-block-id]',
    ) ?? [])
      current[element.dataset.blockId ?? ''] = element.open;
    if (canonical(current) !== canonical(details)) {
      setDetails(current);
      await queue(
        () => invoke('setViewState', { artifactId, revisionId, view: { details: current } }),
        'view',
      );
      if (failedTasks.current.size)
        throw new Error('Retry failed view autosave before annotating.');
    }
    return invoke<AnnotationState>('captureAnnotationState', {
      artifactId,
      revisionId,
      view: { details: current },
    });
  }
  async function begin(): Promise<void> {
    if (!candidate) return;
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
    const bounds = range ? Array.from(range.getClientRects()).at(-1) : null;
    if (bounds) commentAnchor.current = { x: bounds.right, y: bounds.top + bounds.height / 4 };
    const complete = beginContextWrite();
    try {
      const context = await annotationContext();
      const next = { ...candidate, stateContext: context };
      setSelection(next);
      setCandidate(null);
      setComment('');
      await invoke('editing', { active: true });
      await queue(() =>
        invoke('saveEditor', { artifactId, revisionId, editor: { selection: next, comment: '' } }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      complete();
    }
  }
  async function dismiss(): Promise<void> {
    await queue(() => invoke('saveEditor', { artifactId, revisionId, editor: null }));
    if (failedTasks.current.size)
      throw new Error('Local save failed. Retry before dismissing the comment.');
    setSelection(null);
    setCandidate(null);
    setComment('');
    window.getSelection()?.removeAllRanges();
    await invoke('editing', { active: false });
  }
  async function addComment(): Promise<void> {
    if (!selection || !comment.trim()) return;
    try {
      await saves.current;
      if (failedTasks.current.size)
        throw new Error('Retry failed autosave before fixing the comment.');
      const annotation = await invoke<{ id: string }>('addAnnotation', {
        artifactId,
        revisionId,
        ...selection,
        comment: comment.trim(),
      });
      await dismiss();
      await reload();
      if (selection.kind === 'document-area')
        await invoke('browserShowCapture', { artifactId, revisionId, annotationId: annotation.id });
    } catch (e) {
      setError(message(e));
      throw e;
    }
  }
  useEffect(() => {
    function finish(event: MessageEvent): void {
      if (
        event.source !== window.parent ||
        event.data?.type !== 'projector-finish' ||
        typeof event.data.id !== 'string'
      )
        return;
      const target = event.source as Window,
        id = event.data.id,
        origin = event.origin;
      void (async () => {
        await contextWork.current;
        if (paneId && scrollTimer.current) {
          clearTimeout(scrollTimer.current);
          scrollTimer.current = null;
          await queue(
            () => invoke('setViewState', { artifactId, revisionId, scrollTop: window.scrollY }),
            'scroll',
          );
        }
        if (event.data.retry) for (const [key, task] of failedTasks.current) await queue(task, key);
        await saves.current;
        if (failedTasks.current.size)
          throw new Error('Local save failed. Retry or cancel before leaving.');
        await composer.current?.finish();
        await saves.current;
        if (failedTasks.current.size)
          throw new Error('Local save failed. Retry or cancel before leaving.');
      })()
        .then(() => target.postMessage({ type: 'projector-finished', id }, origin))
        .catch((error) =>
          target.postMessage({ type: 'projector-finished', id, error: message(error) }, origin),
        );
    }
    window.addEventListener('message', finish);
    return () => window.removeEventListener('message', finish);
  });
  async function finishArea(): Promise<void> {
    const input = gesture.current;
    if (!input) return;
    gesture.current = null;
    const dragged = Math.hypot(input.end.x - input.start.x, input.end.y - input.start.y) >= 4;
    const rect = dragged
      ? {
          x: Math.min(input.start.x, input.end.x),
          y: Math.min(input.start.y, input.end.y),
          width: Math.abs(input.start.x - input.end.x),
          height: Math.abs(input.start.y - input.end.y),
        }
      : input.hover;
    if (!rect) return;
    setAreaStart(null);
    setAreaEnd(null);
    setAreaMode(false);
    if (rect.width < 3 || rect.height < 3) return;
    const complete = beginContextWrite();
    try {
      const stateContext = await annotationContext();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const capture = await invoke<Record<string, unknown>>('captureDocumentArea', {
        artifactId,
        revisionId,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        pointer: input.end,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroll: { x: window.scrollX, y: window.scrollY },
        zoom: window.devicePixelRatio,
      });
      const next: SelectionData = {
        kind: 'document-area',
        quote: 'Selected document area',
        prefix: '',
        suffix: '',
        blockId: input.hover?.blockId ?? 'document',
        capture,
        stateContext,
      };
      setSelection(next);
      setComment('');
      commentAnchor.current = input.end;
      setPopover({
        x: Math.min(rect.x, window.innerWidth - 340),
        y: Math.min(rect.y + rect.height + 8, window.innerHeight - 260),
      });
      await invoke('editing', { active: true });
      await queue(() =>
        invoke('saveEditor', { artifactId, revisionId, editor: { selection: next, comment: '' } }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      complete();
    }
  }
  function render(node: DocumentNode, key: string): React.ReactNode {
    const children = node.children?.map((child, index) => render(child, `${key}-${index}`));
    const props = node.props ?? {};
    const widgetId =
      typeof props.widgetId === 'string'
        ? props.widgetId
        : typeof props.id === 'string'
          ? props.id
          : node.id;
    const widget = parsed?.widgets.find((item) => item.id === widgetId);
    if (widget)
      return (
        <Widget
          key={key}
          definition={widget}
          value={displayValues[widget.id]}
          update={update}
          readOnly={data?.draft || Boolean(previewState) || contextPending || Boolean(selection)}
        />
      );
    const common = { 'data-block-id': node.id ?? key };
    switch (node.type) {
      case 'root':
        return <React.Fragment key={key}>{children}</React.Fragment>;
      case 'text':
        return (
          <span key={key} data-text-path={JSON.stringify(key.split('-').map(Number))}>
            {node.value}
          </span>
        );
      case 'paragraph':
        return <p key={key} {...common}>{children}</p>;
      case 'heading': {
        const Heading =
          `h${Math.max(1, Math.min(6, typeof props.depth === 'number' ? props.depth : 2))}` as
            'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
        return <Heading key={key} {...common}>{children}</Heading>;
      }
      case 'strong':
        return <strong key={key}>{children}</strong>;
      case 'emphasis':
        return <em key={key}>{children}</em>;
      case 'delete':
        return <del key={key}>{children}</del>;
      case 'inlineCode':
        return (
          <code key={key}>
            <span data-text-path={JSON.stringify(key.split('-').map(Number))}>{node.value}</span>
          </code>
        );
      case 'code':
        return props.language === 'mermaid' ? (
          <Diagram key={key} source={node.value ?? ''} />
        ) : (
          <pre key={key} {...common}>
            <code>
              <span data-text-path={JSON.stringify(key.split('-').map(Number))}>{node.value}</span>
            </code>
          </pre>
        );
      case 'blockquote':
        return <blockquote key={key} {...common}>{children}</blockquote>;
      case 'list':
        return props.ordered ? (
          <ol key={key} {...common} start={typeof props.start === 'number' ? props.start : 1}>
            {children}
          </ol>
        ) : (
          <ul key={key} {...common}>{children}</ul>
        );
      case 'listItem':
        return (
          <li key={key} {...common}>
            {typeof props.checked === 'boolean' && (
              <input type="checkbox" checked={props.checked} disabled />
            )}
            {children}
          </li>
        );
      case 'table':
        return (
          <div className="table-wrap" key={key}>
            <table data-block-id={node.id ?? key}>
              <tbody>{children}</tbody>
            </table>
          </div>
        );
      case 'tableRow':
        return <tr key={key}>{children}</tr>;
      case 'tableCell':
        return <td key={key} {...common}>{children}</td>;
      case 'link':
        return (
          <span
            key={key}
            className="document-link"
            title={typeof props.url === 'string' ? props.url : ''}
          >
            {children}
          </span>
        );
      case 'image':
        return (
          <span key={key} {...common} className="image-placeholder">
            {typeof props.alt === 'string' ? props.alt : 'Image'} · external image preview
            unavailable in Alpha 1
          </span>
        );
      case 'thematicBreak':
        return <hr key={key} {...common} />;
      case 'break':
        return <br key={key} />;
      case 'Details':
      case 'details':
        return (
          <details
            key={key} {...common}
            open={displayDetails[node.id ?? key] ?? false}
            onToggle={(e) => {
              if (data?.draft || previewState) return;
              const open = e.currentTarget.open,
                id = node.id ?? key;
              if (details[id] === open) return;
              const next = { ...details, [id]: open };
              setDetails(next);
              void queue(
                () => invoke('setViewState', { artifactId, revisionId, view: { details: next } }),
                'view',
              );
            }}
          >
            <summary
              onClick={(e) => {
                if (previewState || contextPending || selection) e.preventDefault();
              }}
              aria-disabled={Boolean(previewState || contextPending || selection)}
            >
              {typeof props.title === 'string' ? props.title : 'Details'}
            </summary>
            {children}
          </details>
        );
      case 'Callout':
      case 'callout':
        return (
          <aside key={key} {...common} className="callout">
            {typeof props.title === 'string' && <strong>{props.title}</strong>}
            {children}
          </aside>
        );
      case 'Mermaid':
        return (
          <Diagram
            key={key}
            source={typeof props.source === 'string' ? props.source : (node.value ?? '')}
          />
        );
      case 'component':
      case 'mdxJsxFlowElement':
      case 'mdxJsxTextElement': {
        const name =
          typeof props.name === 'string'
            ? props.name
            : (node as DocumentNode & { name?: string }).name;
        if (name) return render({ ...node, type: name }, key);
        return <div key={key} {...common}>{children}</div>;
      }
      default:
        return <div key={key} {...common}>{node.value ?? children}</div>;
    }
  }
  return (
    <div className="surface">
      {error && (
        <div className="error-banner" role="alert">
          {error}
          {failedTasks.current.size > 0 && (
            <button
              onClick={() => {
                for (const [key, task] of failedTasks.current) void queue(task, key);
              }}
            >
              Retry autosave
            </button>
          )}
          <button onClick={() => setError('')}>
<Icon name="close" />
</button>
        </div>
      )}
      {data?.error && (
        <section className="draft-diagnostic">
          <div role="alert" className="error-banner">
            {data.error}
          </div>
          <pre>{data.source}</pre>
        </section>
      )}
      {previewState && (
        <div className="state-preview-banner" role="status">
          Annotation state preview · read-only
          <button
            onClick={() => {
              pendingJump.current = null;
              setPreviewState(null);
              setFocused('');
            }}
          >
            Return to working state
          </button>
        </div>
      )}
      <article
        ref={article}
        inert={contextPending}
        className="plan-document"
        data-block-id="document"
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
      >
        {parsed ? (
          parsed.blocks.map((node, index) => render(node, String(index)))
        ) : (
          <p className="muted">
            {data?.draft ? 'Waiting for the agent to write the MDX source.' : 'Loading document…'}
          </p>
        )}
      </article>
      <div className="annotation-layer" aria-hidden="true">
        {highlights.map((a, annotationIndex) => (
          <React.Fragment key={a.id}>
            {a.rects.map((r, i) => (
              <span
                key={i}
                className={`text-highlight ${focused === a.id ? 'focused' : ''}`}
                style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
              />
            ))}
            {a.markerVisible &&
              a.pointer &&
              (() => {
                const pointer = {
                  x: a.pointer.x - window.scrollX,
                  y: a.pointer.y - window.scrollY,
                };
                const overlap = highlights
                  .slice(0, annotationIndex)
                  .filter(
                    (previous) =>
                      previous.markerVisible &&
                      previous.pointer &&
                      Math.abs(previous.pointer.x - a.pointer!.x) < 8 &&
                      Math.abs(previous.pointer.y - a.pointer!.y) < 8,
                  ).length;
                const base = markerGeometry(pointer, { width: innerWidth, height: innerHeight });
                const center = overlap ? { x: base.cx + overlap * 24, y: base.cy } : undefined;
                const { cx, cy, path } = markerGeometry(
                  pointer,
                  { width: innerWidth, height: innerHeight },
                  center,
                );
                return (
                  <svg
                    className="area-annotation-number inline-annotation-number"
                    data-pointer-x={a.pointer.x}
                    data-pointer-y={a.pointer.y}
                    style={{ left: window.scrollX, top: window.scrollY }}
                    width={innerWidth}
                    height={innerHeight}
                    aria-label={`Annotation ${a.number}`}
                  >
                    <path
                      d={path}
                      fill="#4263da"
                      stroke="white"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                    />
                    <text
                      x={cx}
                      y={cy}
                      dominantBaseline="central"
                      textAnchor="middle"
                      fontSize="10"
                      fontWeight="600"
                      fill="white"
                    >
                      {a.number}
                    </text>
                  </svg>
                );
              })()}
          </React.Fragment>
        ))}
      </div>
      {candidate && !selection && (
        <button
          className="selection-annotate"
          style={{ left: popover.x, top: popover.y }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void begin()}
        >
          Annotate
        </button>
      )}
      {selection && !contextPending && (
        <div
          ref={popoverElement}
          className="annotation-popover"
          style={{ left: popover.x, top: popover.y }}
        >
          <CommentComposer
            ref={composer}
            label="Annotation comment"
            saveLabel="Save private annotation"
            value={comment}
            onChange={(value) => {
              setComment(value);
              void queue(() =>
                invoke('saveEditor', {
                  artifactId,
                  revisionId,
                  editor: { selection, comment: value },
                }),
              );
            }}
            onSave={addComment}
            onCancel={dismiss}
            onError={(error) => setError(message(error))}
          />
        </div>
      )}
      {contextPending && <div className="capture-input-shield" aria-hidden="true" />}
      {areaMode && (
        <div
          className="area-selection-overlay"
          role="application"
          aria-label="Select annotation area"
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const point = { x: e.clientX, y: e.clientY };
            gesture.current = { start: point, end: point, hover: hoverRef.current };
            setAreaStart(point);
            setAreaEnd(point);
          }}
          onPointerMove={(e) => {
            const point = { x: e.clientX, y: e.clientY };
            if (gesture.current) {
              gesture.current.end = point;
              setAreaEnd(point);
              return;
            }
            const target = document
              .elementsFromPoint(point.x, point.y)
              .find(
                (element) =>
                  article.current?.contains(element) && !element.closest('.annotation-layer'),
              );
            const semantic = target?.closest<HTMLElement>('[data-block-id],.widget,.diagram');
            if (!semantic || semantic === article.current) {
              hoverRef.current = null;
              setHovered(null);
              return;
            }
            const bounds = semantic.getBoundingClientRect();
            const next = {
              x: Math.max(0, bounds.x),
              y: Math.max(0, bounds.y),
              width: Math.min(bounds.right, innerWidth) - Math.max(0, bounds.x),
              height: Math.min(bounds.bottom, innerHeight) - Math.max(0, bounds.y),
              blockId: semantic.dataset.blockId ?? semantic.dataset.widgetId ?? 'document',
            };
            hoverRef.current = next;
            setHovered(next);
          }}
          onPointerUp={(e) => {
            if (gesture.current) gesture.current.end = { x: e.clientX, y: e.clientY };
            void finishArea();
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const blocks = Array.from(
                article.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? [],
              ).filter(
                (block) => block.getClientRects().length > 0 && !block.closest('.annotation-layer'),
              );
              if (!blocks.length) return;
              keyboardAreaIndex.current =
                (keyboardAreaIndex.current + (e.key === 'ArrowDown' ? 1 : -1) + blocks.length) %
                blocks.length;
              const block = blocks[keyboardAreaIndex.current];
              block.scrollIntoView({ block: 'center' });
              const bounds = block.getBoundingClientRect();
              const next = {
                x: Math.max(0, bounds.x),
                y: Math.max(0, bounds.y),
                width: Math.min(bounds.right, innerWidth) - Math.max(0, bounds.x),
                height: Math.min(bounds.bottom, innerHeight) - Math.max(0, bounds.y),
                blockId: block.dataset.blockId ?? 'document',
              };
              hoverRef.current = next;
              setHovered(next);
            } else if (e.key === 'Enter' && hoverRef.current && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const rect = hoverRef.current;
              const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
              gesture.current = { start: point, end: point, hover: rect };
              void finishArea();
            } else if (e.key === 'Escape') {
              setAreaMode(false);
              gesture.current = null;
              setAreaStart(null);
              setAreaEnd(null);
            }
          }}
        >
          <span className="area-instructions">
            Click an element or drag an area · ↑/↓ select · Enter annotate · Escape cancel
          </span>
          {hovered && !areaStart && (
            <div
              className="element-hover-outline"
              style={{
                left: hovered.x,
                top: hovered.y,
                width: hovered.width,
                height: hovered.height,
              }}
            />
          )}
          {areaStart && areaEnd && (
            <div
              className="area-rectangle"
              style={{
                left: Math.min(areaStart.x, areaEnd.x),
                top: Math.min(areaStart.y, areaEnd.y),
                width: Math.abs(areaStart.x - areaEnd.x),
                height: Math.abs(areaStart.y - areaEnd.y),
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(isSurface ? <DocumentSurface /> : <App />);
