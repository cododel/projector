import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import mermaid from 'mermaid';
import type { DocumentNode, WidgetDefinition } from '../document/types';
import './style.css';
import { markerGeometry, commentPosition } from '../shared/annotation-marker';
import { CommentComposer, type CommentComposerHandle } from './CommentComposer';
import type { WorkspaceSnapshot } from '../shared/workspace';
import { captureTextSelection, anchorRange } from './anchors';
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
  revisionId: string;
  comment: string;
  number?: number;
}
interface Project {
  id: string;
  path: string;
}
interface Artifact {
  id: string;
  projectId: string;
  title: string;
  originSession: { harness: string; sessionId: string };
  latestRevision: string | null;
  displayStatus?: string;
  privateChanges?: boolean;
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
}
interface BrowserSnapshot {
  tabs: BrowserTab[];
  activeTabId: string | null;
  annotating: boolean;
}
interface Bridge {
  invoke(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onRefresh(callback: () => void): (() => void) | void;
}
const isSurface = new URLSearchParams(window.location.search).get('surface') === '1';
function documentShellOrigin(): string {
  const requestedOrigin =
    new URLSearchParams(window.location.search).get('shellOrigin') ?? 'blueprint://app';
  const originUrl = new URL(requestedOrigin);
  return requestedOrigin === 'blueprint://app' ||
    (originUrl.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname))
    ? requestedOrigin
    : 'blueprint://app';
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
    const data = event.data as { type?: string; id?: string; result?: unknown; error?: string };
    if (data.type === 'blueprint-refresh') {
      for (const listener of listeners) listener();
      return;
    }
    if (data.type !== 'blueprint-response' || typeof data.id !== 'string') return;
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
        window.parent.postMessage({ type: 'blueprint-request', id, method, params }, shellOrigin);
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
  : (window as unknown as { blueprint: Bridge }).blueprint;
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
function Icon({
  name,
}: {
  name: 'edit' | 'delete' | 'folder' | 'codex' | 'sidebar-left' | 'sidebar-right';
}): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      {name === 'sidebar-left' || name === 'sidebar-right' ? (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d={name === 'sidebar-left' ? 'M9 4v16' : 'M15 4v16'} />
        </>
      ) : name === 'edit' ? (
        <path d="m16 3 5 5-13 13H3v-5L16 3ZM13 6l5 5" />
      ) : name === 'folder' ? (
        <path d="M3 7V5h6l2 2h10v13H3V7Z" />
      ) : name === 'codex' ? (
        <>
          <path d="m12 2 8 5v10l-8 5-8-5V7l8-5Z" />
          <path d="m10 8-4 4 4 4m4-8 4 4-4 4" />
        </>
      ) : (
        <>
          <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
        </>
      )}
    </svg>
  );
}
function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<import('../shared/protocol').McpSetup | null>(null);
  const [notification, setNotification] = useState('');
  const [document, setDocument] = useState<DocumentResult | null>(null);
  const [editing, setEditing] = useState<Annotation | null>(null);
  const [comment, setComment] = useState('');
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [savingCount, setSavingCount] = useState(0);
  const [failedAutosaves, setFailedAutosaves] = useState<Set<string>>(new Set());
  const [documentEditing, setDocumentEditing] = useState(false);
  const [documentPreview, setDocumentPreview] = useState(false);
  const [jump, setJump] = useState<Annotation | null>(null);
  const [browser, setBrowser] = useState<BrowserSnapshot>({
    tabs: [],
    activeTabId: null,
    annotating: false,
  });
  const [url, setUrl] = useState('');
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>({
    plans: {},
    layout: { leftSidebarVisible: true, rightSidebarVisible: true },
  });
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
      { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
    >(),
  );
  const [retryTransition, setRetryTransition] = useState<(() => Promise<void>) | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const saveIntent = useRef<Record<string, unknown> | null>(null);
  const browserArea = useRef<HTMLDivElement>(null);
  const homeAddress = useRef<HTMLInputElement>(null);
  const restoredEditing = useRef<string | null>(null);
  const editWrites = useRef(Promise.resolve());
  const editWriteError = useRef<string | null>(null);
  const failedEditWrite = useRef<(() => Promise<unknown>) | null>(null);
  const transitioning = useRef(false);
  const homeWrites = useRef(Promise.resolve());
  const failedHomeWrite = useRef<(() => Promise<unknown>) | null>(null);
  const reloadGeneration = useRef(0);
  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current;
    const next = await invoke<Snapshot>('snapshot');
    const loaded = next.selected
      ? await invoke<DocumentResult>('getDocument', next.selected)
      : null;
    const nextBrowser = await invoke<BrowserSnapshot>('browserSnapshot');
    const nextWorkspace = await invoke<WorkspaceSnapshot>('workspaceSnapshot');
    if (generation !== reloadGeneration.current) return;
    // Commit one coherent view; an older preview response must never navigate a published frame back.
    setSnapshot(next);
    setDocument(loaded);
    setBrowser(nextBrowser);
    setWorkspace(nextWorkspace);
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
        void invoke('editing', { active: true });
      }
    }
  }, []);
  useEffect(() => {
    void reload().catch((e) => setError(message(e)));
    return bridge.onRefresh(() => {
      void reload().catch((e) => setError(message(e)));
    });
  }, [reload]);
  const selected = snapshot.selected;
  const artifact = snapshot.artifacts.find((item) => item.id === selected?.artifactId);
  useEffect(() => {
    if (selected?.artifactId)
      void invoke('browserRestoreDraft', { artifactId: selected.artifactId })
        .then(() => invoke<BrowserSnapshot>('browserSnapshot'))
        .then(setBrowser)
        .catch((e) => setError(message(e)));
  }, [selected?.artifactId]);
  const annotations = (
    snapshot.draft?.annotations ??
    snapshot.annotations ??
    document?.annotations ??
    []
  ).filter((item) => item.artifactId === artifact?.id);
  const planTabs = selected ? workspace.plans[selected.artifactId] : undefined;
  const activeTab = planTabs?.tabs.find((t) => t.id === planTabs.activeTabId);
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
  ]);
  async function action(callback: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await callback();
      await reload();
    } catch (e) {
      setError(message(e));
      try {
        await reload();
      } catch {
        /* Preserve the original failure if runtime is disconnected. */
      }
    } finally {
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
    if (frame.current?.contentWindow && surfaceReady.current) {
      const target = frame.current.contentWindow,
        id = crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          finishRequests.current.delete(id);
          reject(new Error('Comment editor did not respond. Retry before leaving.'));
        }, 10000);
        finishRequests.current.set(id, { resolve, reject, timer });
        target.postMessage({ type: 'blueprint-finish', id, retry }, 'blueprint://document');
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
      if ((event.target as Element | null)?.closest('.annotation-comment-composer')) return;
      void finishEditors().catch((error) => setError(message(error)));
    };
    window.document.addEventListener('pointerdown', outside);
    return () => window.document.removeEventListener('pointerdown', outside);
  });
  async function transition(callback: () => Promise<unknown>, retry = false): Promise<void> {
    if (transitioning.current) return;
    transitioning.current = true;
    setBusy(true);
    setError('');
    try {
      await finishEditors(retry);
      setBusy(true);
      await callback();
      await reload();
      setRetryTransition(null);
    } catch (error) {
      setError(message(error));
      setRetryTransition(() => () => transition(callback, true));
    } finally {
      transitioning.current = false;
      setBusy(false);
    }
  }
  const tabCommand = (action: string, tabId?: string) =>
    transition(() =>
      invoke('workspaceCommand', { artifactId: selected?.artifactId, action, tabId }),
    );
  async function toggleSidebar(side: 'left' | 'right'): Promise<void> {
    const previous = workspace.layout ?? { leftSidebarVisible: true, rightSidebarVisible: true };
    const layout = {
      ...previous,
      [side === 'left' ? 'leftSidebarVisible' : 'rightSidebarVisible']:
        !previous[side === 'left' ? 'leftSidebarVisible' : 'rightSidebarVisible'],
    };
    setWorkspace((current) => ({ ...current, layout }));
    try {
      await invoke('workspaceLayout', layout);
    } catch (error) {
      setWorkspace((current) => ({ ...current, layout: previous }));
      setError(message(error));
    }
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
  useEffect(() => {
    function relay(event: MessageEvent): void {
      if (
        event.origin !== 'blueprint://document' ||
        event.source !== frame.current?.contentWindow ||
        !event.data ||
        typeof event.data !== 'object'
      )
        return;
      if (event.data.type === 'blueprint-document-status') {
        setDocumentToolbar({
          saveStatus: typeof event.data.saveStatus === 'string' ? event.data.saveStatus : '',
          areaMode: event.data.areaMode === true,
          canAnnotate: event.data.canAnnotate === true,
        });
        return;
      }
      if (event.data.type === 'blueprint-finished' && typeof event.data.id === 'string') {
        const pending = finishRequests.current.get(event.data.id);
        if (pending) {
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
        request.type !== 'blueprint-request' ||
        typeof request.id !== 'string' ||
        typeof request.method !== 'string'
      )
        return;
      const target = event.source as Window;
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
      if (
        !allowed.includes(request.method) ||
        !selected ||
        (!['editing', 'previewing'].includes(request.method) &&
          (params.artifactId !== selected.artifactId || params.revisionId !== selected.revisionId))
      ) {
        target.postMessage(
          {
            type: 'blueprint-response',
            id: request.id,
            error: 'Document operation is not allowed.',
          },
          'blueprint://document',
        );
        return;
      }
      if (request.method === 'previewing') {
        setDocumentPreview(params.active === true);
        target.postMessage(
          { type: 'blueprint-response', id: request.id, result: {} },
          'blueprint://document',
        );
        return;
      }
      if (request.method === 'annotationNavigated') {
        setJump(null);
        target.postMessage(
          { type: 'blueprint-response', id: request.id, result: {} },
          'blueprint://document',
        );
        return;
      }
      if (['setValue', 'saveEditor', 'setViewState'].includes(String(request.method)))
        setSavingCount((c) => c + 1);
      if (request.method === 'editing') setDocumentEditing(params.active === true);
      const saveKey = `${selected.artifactId}:${String(request.method)}:${String(params.widgetId ?? 'editor')}`;
      void bridge
        .invoke(request.method, params)
        .then((result) => {
          if (['setValue', 'saveEditor', 'setViewState'].includes(String(request.method)))
            setFailedAutosaves((previous) => {
              const next = new Set(previous);
              next.delete(saveKey);
              return next;
            });
          target.postMessage(
            { type: 'blueprint-response', id: request.id, result },
            'blueprint://document',
          );
          if (
            request.method === 'getDocument' &&
            jump !== null &&
            jump.artifactId === params.artifactId &&
            jump.revisionId === params.revisionId
          )
            target.postMessage(
              { type: 'blueprint-jump', annotation: jump },
              'blueprint://document',
            );
          if (!['getDocument', 'editing'].includes(String(request.method)))
            void reload().catch((e) => setError(message(e)));
        })
        .catch((e) => {
          if (['setValue', 'saveEditor', 'setViewState'].includes(String(request.method)))
            setFailedAutosaves((previous) => new Set(previous).add(saveKey));
          target.postMessage(
            { type: 'blueprint-response', id: request.id, error: message(e) },
            'blueprint://document',
          );
        })
        .finally(() => {
          if (['setValue', 'saveEditor', 'setViewState'].includes(String(request.method)))
            setSavingCount((c) => c - 1);
        });
    }
    window.addEventListener('message', relay);
    return () => window.removeEventListener('message', relay);
  }, [selected?.artifactId, selected?.revisionId, reload, jump]);
  useEffect(
    () =>
      bridge.onRefresh(() =>
        frame.current?.contentWindow?.postMessage(
          { type: 'blueprint-refresh' },
          'blueprint://document',
        ),
      ),
    [],
  );
  function sendJump(): void {
    if (jump)
      frame.current?.contentWindow?.postMessage(
        { type: 'blueprint-jump', annotation: jump },
        'blueprint://document',
      );
  }
  useEffect(() => {
    sendJump();
  }, [jump, document]);
  const surfaceUrl = selected
    ? `blueprint://document/index.html?surface=1&artifactId=${encodeURIComponent(selected.artifactId)}&revisionId=${encodeURIComponent(selected.revisionId ?? '')}&shellOrigin=${encodeURIComponent(window.location.origin)}`
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
      await invoke('editing', { active: false });
    }
    await reload();
  }
  async function jumpTo(annotation: Annotation): Promise<void> {
    if (annotation.kind === 'browser-area') {
      await invoke('browserShowCapture', {
        artifactId: annotation.artifactId,
        annotationId: annotation.id,
      });
      return;
    }
    await invoke('browserSelect', { tabId: null });
    await invoke('openArtifact', {
      artifactId: annotation.artifactId,
      revisionId: annotation.revisionId,
    });
    setJump(annotation);
    if (annotation.kind === 'document-area')
      await invoke('browserShowCapture', {
        artifactId: annotation.artifactId,
        annotationId: annotation.id,
      });
  }
  return (
    <div
      className={`app ${workspace.layout?.leftSidebarVisible === false ? 'left-sidebar-hidden' : ''} ${workspace.layout?.rightSidebarVisible === false ? 'right-sidebar-hidden' : ''}`}
    >
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">B</span>
          <div>
            Blueprint<small>ALPHA 1 · LOCAL WORKSPACE</small>
          </div>
        </div>
        <div className="project-tree">
          <div className="tree-heading">Projects</div>
          {snapshot.projects.map((item) => (
            <section key={item.id}>
              <button
                className={`project-row ${item.id === projectId ? 'current' : ''}`}
                title={item.path}
                aria-expanded={!collapsed.has(item.id)}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(item.id)) next.delete(item.id);
                    else next.add(item.id);
                    return next;
                  })
                }
              >
                <span aria-hidden="true">{collapsed.has(item.id) ? '▸' : '▾'}</span>
                <Icon name="folder" />
                <span>{item.path.split('/').filter(Boolean).at(-1)}</span>
              </button>
              {!collapsed.has(item.id) &&
                snapshot.artifacts
                  .filter((a) => a.projectId === item.id)
                  .map((plan) => (
                    <div
                      key={plan.id}
                      className={`plan-row ${selected?.artifactId === plan.id ? 'active' : ''}`}
                    >
                      <span
                        className={`plan-status ${plan.displayStatus === 'Approved' ? 'approved' : ''}`}
                        title={plan.displayStatus ?? (plan.latestRevision ? 'In review' : 'Draft')}
                        aria-label={plan.displayStatus ?? 'Draft'}
                      >
                        {plan.displayStatus === 'Approved' ? '✓' : plan.latestRevision ? '◷' : '◇'}
                      </span>
                      <button
                        className="plan-title"
                        title={plan.title}
                        disabled={busy}
                        onClick={() =>
                          void transition(() =>
                            invoke('openArtifact', {
                              artifactId: plan.id,
                              revisionId:
                                workspace.plans[plan.id]?.lastDocumentRevisionId ??
                                workspace.plans[plan.id]?.tabs.find(
                                  (tab) => tab.kind === 'document',
                                )?.revisionId ??
                                plan.latestRevision,
                            }),
                          )
                        }
                      >
                        {plan.title}
                      </button>
                      {plan.privateChanges && (
                        <span
                          className="private-dot"
                          title="Private changes"
                          aria-label="Private changes"
                        />
                      )}
                      {plan.originSession.harness === 'codex' && (
                        <button
                          className="session-link"
                          title="Open linked Codex session · availability unverified"
                          aria-label={`Open Codex session for ${plan.title}`}
                          onClick={() =>
                            void action(() => invoke('openSession', { artifactId: plan.id }))
                          }
                        >
                          <Icon name="codex" />
                        </button>
                      )}
                    </div>
                  ))}
            </section>
          ))}
          <button
            className="subtle full"
            disabled={busy}
            onClick={() => void transition(() => invoke('chooseProject'))}
          >
            + Open project folder
          </button>
        </div>
        <div className="sidebar-bottom">
          <span className="runtime-dot" /> Local runtime active
          <button
            className="subtle full"
            onClick={() => void action(async () => setSetup(await invoke('setup')))}
          >
            MCP connection
          </button>
        </div>
      </aside>
      <main className="workspace">
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
              ×
            </button>
          </div>
        )}
        {selected ? (
          <>
            <div className="tab-bar">
              <button
                className="sidebar-toggle"
                aria-label={
                  workspace.layout?.leftSidebarVisible === false
                    ? 'Show projects sidebar'
                    : 'Hide projects sidebar'
                }
                title={
                  workspace.layout?.leftSidebarVisible === false
                    ? 'Show projects sidebar'
                    : 'Hide projects sidebar'
                }
                aria-pressed={workspace.layout?.leftSidebarVisible !== false}
                onClick={() => void toggleSidebar('left')}
              >
                <Icon name="sidebar-left" />
              </button>
              <nav className="content-tabs" role="tablist" aria-label="Plan tabs">
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
                      ×
                    </button>
                  </div>
                ))}
                <button
                  className="new-tab"
                  title="New tab"
                  aria-label="New tab"
                  disabled={busy}
                  onClick={() => void tabCommand('new')}
                >
                  +
                </button>
              </nav>
              <button
                className="sidebar-toggle"
                aria-label={
                  workspace.layout?.rightSidebarVisible === false
                    ? 'Show feedback sidebar'
                    : 'Hide feedback sidebar'
                }
                title={
                  workspace.layout?.rightSidebarVisible === false
                    ? 'Show feedback sidebar'
                    : 'Hide feedback sidebar'
                }
                aria-pressed={workspace.layout?.rightSidebarVisible !== false}
                onClick={() => void toggleSidebar('right')}
              >
                <Icon name="sidebar-right" />
              </button>
            </div>
            <header className="plan-header">
              <h1 title={artifact?.title}>{artifact?.title ?? 'Blueprint'}</h1>{' '}
              {selected && (
                <div className="version-tools">
                  {selected.revisionId && (
                    <label>
                      <select
                        disabled={busy}
                        aria-label="Document version"
                        value={selected.revisionId}
                        onChange={(e) =>
                          void transition(() =>
                            invoke('openArtifact', {
                              artifactId: selected.artifactId,
                              revisionId: e.target.value,
                            }),
                          )
                        }
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
                          { type: 'blueprint-toggle-annotate' },
                          'blueprint://document',
                        );
                      })
                    }
                  >
                    Annotate
                  </button>
                </>
              )}
            </header>
            {activeBrowser ? (
              <>
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
                    ←
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
                    →
                  </button>
                  <button
                    aria-label="Reload"
                    onClick={() =>
                      void transition(() =>
                        invoke('browserCommand', { tabId: activeBrowser.id, action: 'reload' }),
                      )
                    }
                  >
                    ↻
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
                  <button className="primary" disabled={busy || !artifact?.latestRevision}>
                    Open
                  </button>
                </form>
                {!artifact?.latestRevision && (
                  <p className="muted">Publish the plan before opening browser content.</p>
                )}
              </div>
            ) : activeTab?.kind === 'document' ? (
              <iframe
                ref={frame}
                sandbox="allow-scripts allow-same-origin"
                className="document-frame"
                title="Blueprint document"
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
            <div className="workspace-welcome-toolbar">
              <button
                className="sidebar-toggle"
                aria-label={
                  workspace.layout?.leftSidebarVisible === false
                    ? 'Show projects sidebar'
                    : 'Hide projects sidebar'
                }
                title="Toggle projects sidebar"
                onClick={() => void toggleSidebar('left')}
              >
                <Icon name="sidebar-left" />
              </button>
              <button
                className="sidebar-toggle"
                aria-label={
                  workspace.layout?.rightSidebarVisible === false
                    ? 'Show feedback sidebar'
                    : 'Hide feedback sidebar'
                }
                title="Toggle feedback sidebar"
                onClick={() => void toggleSidebar('right')}
              >
                <Icon name="sidebar-right" />
              </button>
            </div>
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
      </main>
      <aside className="feedback-panel">
        <h2>Feedback</h2>
        <p className="muted">Working changes stay private until Save.</p>
        {artifact && (
          <details className="artifact-properties">
            <summary>Artifact properties</summary>
            <small>Origin: {artifact.originSession.harness} · availability unverified</small>
            <button
              className="secondary full"
              onClick={() => void copy(`codex://threads/${artifact.originSession.sessionId}`)}
            >
              Copy session link
            </button>
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
                  <button
                    className="annotation-jump"
                    onClick={() => void transition(() => jumpTo(annotation))}
                  >
                    <span className="annotation-number">{annotation.number ?? i + 1}</span>
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
                          await invoke('editing', { active: true });
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
                  <p onClick={() => void transition(() => jumpTo(annotation))}>
                    {annotation.comment}
                  </p>
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
                saveIntent.current ??= {
                  ...selected,
                  operationId: crypto.randomUUID(),
                  expectedLatestSavedStateId: document?.latestSavedStateId ?? null,
                };
                try {
                  const result = await invoke<{ id: string; notification: string }>(
                    'saveState',
                    saveIntent.current,
                  );
                  saveIntent.current = null;
                  setNotification(result.notification);
                } catch (e) {
                  if (/STATE_CONFLICT|INVALID_STATE|UNFINISHED_ANNOTATION/.test(message(e)))
                    saveIntent.current = null;
                  throw e;
                }
              })
            }
          >
            {busy
              ? 'Working…'
              : savingCount > 0
                ? 'Autosaving…'
                : saveIntent.current
                  ? 'Retry Save'
                  : 'Save'}
          </button>
          <small>
            {document?.dirty ? 'Unsaved working changes' : 'Saved state is unchanged'} · Save keeps
            annotations and creates an immutable snapshot.
          </small>
          {notification && (
            <div className="notification">
              <button className="secondary full" onClick={() => void copy(notification)}>
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
                document?.approved ||
                document?.dirty
              }
              onClick={() => void action(() => invoke('approve', selected))}
            >
              {document?.approved ? 'This version is approved' : 'Approve this version'}
            </button>
          )}
          <small>Approval records agreement. It does not authorize implementation.</small>
        </div>
        {(snapshot.savedStates ?? []).filter((state) => state.artifactId === artifact?.id).length >
          0 && (
          <details className="package-history">
            <summary>Saved states</summary>
            {snapshot.savedStates
              ?.filter((state) => state.artifactId === artifact?.id)
              .map((state) => (
                <div key={state.id}>
                  <small>{new Date(state.createdAt).toLocaleString()}</small>
                  {state.notification && (
                    <button onClick={() => void copy(state.notification ?? '')}>
                      Copy update message
                    </button>
                  )}
                </div>
              ))}
          </details>
        )}
        {snapshot.packages.filter((p) => !p.projectId || p.projectId === projectId).length > 0 && (
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
      {setup && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-label="MCP connection">
            <div className="modal-heading">
              <h2>Connect Blueprint through MCP</h2>
              <button className="subtle" onClick={() => setSetup(null)}>
                Close
              </button>
            </div>
            <p>Copy the setup prompt and paste it into your agent. Keep Blueprint running.</p>
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
                MCP calls reach this application through a local Unix socket. No TCP port is used.
              </p>
              <label>Runtime socket</label>
              <pre>{setup.socketPath}</pre>
              <label>Stdio command</label>
              <pre>{setup.command}</pre>
              <label>Configuration</label>
              <pre>{setup.config}</pre>
              <button className="secondary" onClick={() => void copy(setup.config)}>
                {copiedText === setup.config ? 'Copied' : 'Copy configuration'}
              </button>
            </details>
            <p className="muted">
              Blueprint does not edit your configuration. The prompt asks your agent to configure
              only this MCP connection.
            </p>
          </section>
        </div>
      )}
    </div>
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
  const [data, setData] = useState<DocumentResult | null>(null);
  const [error, setError] = useState('');
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
          type: 'blueprint-document-status',
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
      if (event.data?.type === 'blueprint-document-status-request') status();
      if (
        event.data?.type === 'blueprint-toggle-annotate' &&
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
  const saving = useRef(false);
  const restored = useRef(false);
  const readGeneration = useRef(0);
  const article = useRef<HTMLElement>(null);
  const pendingJump = useRef<Annotation | null>(null);
  const parsed = data?.revision ?? data?.preview;
  const queue = useCallback((task: () => Promise<unknown>, key = 'editor'): Promise<void> => {
    saving.current = true;
    const token = ++generation.current;
    saves.current = saves.current
      .catch(() => undefined)
      .then(async () => {
        try {
          await task();
          failedTasks.current.delete(key);
          if (token === generation.current) {
            setSaveStatus('Saved locally');
            saving.current = false;
          }
        } catch (e) {
          setError(message(e));
          failedTasks.current.set(key, task);
          setSaveStatus('Save failed');
          if (token === generation.current) saving.current = false;
        }
      });
    return saves.current;
  }, []);
  const reload = useCallback(async () => {
    const readToken = ++readGeneration.current;
    const writeToken = generation.current;
    const next = await invoke<DocumentResult>('getDocument', { artifactId, revisionId });
    if (readToken !== readGeneration.current || writeToken !== generation.current) return;
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
  }, [artifactId, revisionId]);
  useEffect(() => {
    void reload().catch((e) => setError(message(e)));
    return bridge.onRefresh(() => {
      if (!saving.current) void reload().catch((e) => setError(message(e)));
    });
  }, [reload]);
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
  const displayValues = previewState?.values ?? data?.state.values ?? {};
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
          return {
            id: a.id,
            number: a.number ?? i + 1,
            ...(area.length && capture?.pointer
              ? {
                  pointer: {
                    x: capture.pointer.x + (capture.scroll?.x ?? 0),
                    y: capture.pointer.y + (capture.scroll?.y ?? 0),
                  },
                }
              : {}),
            rects: range
              ? Array.from(range.getClientRects()).map((r) => ({
                  x: r.x + window.scrollX,
                  y: r.y + window.scrollY,
                  width: r.width,
                  height: r.height,
                }))
              : area,
          };
        }),
    );
  }, [data?.annotations, revisionId, stateMatches, selection, artifactId]);
  useEffect(() => {
    redraw();
    const observer = new ResizeObserver(redraw);
    if (article.current) observer.observe(article.current);
    window.addEventListener('resize', redraw);
    window.addEventListener('scroll', redraw);
    article.current?.addEventListener('toggle', redraw, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', redraw);
      window.removeEventListener('scroll', redraw);
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
      if (event.source !== window.parent || event.data?.type !== 'blueprint-jump') return;
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
        event.data?.type !== 'blueprint-finish' ||
        typeof event.data.id !== 'string'
      )
        return;
      const target = event.source as Window,
        id = event.data.id,
        origin = event.origin;
      void (async () => {
        await contextWork.current;
        if (event.data.retry) for (const [key, task] of failedTasks.current) await queue(task, key);
        await saves.current;
        if (failedTasks.current.size)
          throw new Error('Local save failed. Retry or cancel before leaving.');
        await composer.current?.finish();
        await saves.current;
        if (failedTasks.current.size)
          throw new Error('Local save failed. Retry or cancel before leaving.');
      })()
        .then(() => target.postMessage({ type: 'blueprint-finished', id }, origin))
        .catch((error) =>
          target.postMessage({ type: 'blueprint-finished', id, error: message(error) }, origin),
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
    const common = { key, 'data-block-id': node.id ?? key };
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
        return <p {...common}>{children}</p>;
      case 'heading': {
        const Heading =
          `h${Math.max(1, Math.min(6, typeof props.depth === 'number' ? props.depth : 2))}` as
            'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
        return <Heading {...common}>{children}</Heading>;
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
          <pre {...common}>
            <code>
              <span data-text-path={JSON.stringify(key.split('-').map(Number))}>{node.value}</span>
            </code>
          </pre>
        );
      case 'blockquote':
        return <blockquote {...common}>{children}</blockquote>;
      case 'list':
        return props.ordered ? (
          <ol {...common} start={typeof props.start === 'number' ? props.start : 1}>
            {children}
          </ol>
        ) : (
          <ul {...common}>{children}</ul>
        );
      case 'listItem':
        return (
          <li {...common}>
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
        return <td {...common}>{children}</td>;
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
          <span {...common} className="image-placeholder">
            {typeof props.alt === 'string' ? props.alt : 'Image'} · external image preview
            unavailable in Alpha 1
          </span>
        );
      case 'thematicBreak':
        return <hr {...common} />;
      case 'break':
        return <br key={key} />;
      case 'Details':
      case 'details':
        return (
          <details
            {...common}
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
          <aside {...common} className="callout">
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
        return <div {...common}>{children}</div>;
      }
      default:
        return <div {...common}>{node.value ?? children}</div>;
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
          <button onClick={() => setError('')}>×</button>
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
        {highlights.flatMap((a, annotationIndex) =>
          a.rects.map((r, i) => (
            <React.Fragment key={`${a.id}-${i}`}>
              <span
                className={`text-highlight ${focused === a.id ? 'focused' : ''}`}
                style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
              />
              {i === a.rects.length - 1 &&
                a.pointer &&
                (() => {
                  const { cx, cy, path } = markerGeometry(
                    { x: a.pointer.x - window.scrollX, y: a.pointer.y - window.scrollY },
                    { width: innerWidth, height: innerHeight },
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
                        y={cy + 4}
                        textAnchor="middle"
                        fontSize="12"
                        fontWeight="600"
                        fill="white"
                      >
                        {a.number}
                      </text>
                    </svg>
                  );
                })()}
              {i === a.rects.length - 1 &&
                !a.pointer &&
                (() => {
                  const overlap = highlights.slice(0, annotationIndex).filter((previous) => {
                    const last = previous.rects.at(-1);
                    return (
                      last &&
                      Math.abs(last.x + last.width - r.x - r.width) < 8 &&
                      Math.abs(last.y - r.y) < 8
                    );
                  }).length;
                  const pointer = {
                    x: r.x + r.width - window.scrollX,
                    y: r.y + r.height / 4 - window.scrollY,
                  };
                  const center = overlap
                    ? { x: pointer.x + 10 + overlap * 24, y: pointer.y - 14 }
                    : undefined;
                  const { cx, cy, path } = markerGeometry(
                    pointer,
                    { width: innerWidth, height: innerHeight },
                    center,
                  );
                  return (
                    <svg
                      className="area-annotation-number inline-annotation-number"
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
                        y={cy + 4}
                        textAnchor="middle"
                        fontSize="12"
                        fontWeight="600"
                        fill="white"
                      >
                        {a.number}
                      </text>
                    </svg>
                  );
                })()}
            </React.Fragment>
          )),
        )}
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
            if (e.key === 'Escape') {
              setAreaMode(false);
              gesture.current = null;
              setAreaStart(null);
              setAreaEnd(null);
            }
          }}
        >
          <span className="area-instructions">
            Click an element or drag an area · Escape to cancel
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
