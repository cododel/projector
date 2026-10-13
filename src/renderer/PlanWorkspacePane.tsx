import React, { useEffect, useRef, useState } from 'react';
import type { PaneContent } from '../shared/application-workspace';

type PlanContent = Extract<PaneContent, { kind: 'plan' }>;
export interface DocumentFrame {
  frame: HTMLIFrameElement;
  artifactId: string;
  revisionId: string | null;
  paneId: string;
  key: string;
  ready: boolean;
}
interface PaneBridge {
  invoke(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
export function PlanDocumentPane({
  content,
  paneId,
  workspaceKey,
  bridge,
  refreshToken,
  register,
  onFocus,
  onNewTab,
  onCopy,
  message,
}: {
  content: PlanContent;
  paneId: string;
  workspaceKey: string;
  bridge: PaneBridge;
  refreshToken: object;
  register(paneId: string, value: DocumentFrame | null): void;
  onFocus(): void;
  onNewTab(): void;
  onCopy(): void;
  message: string;
}): React.JSX.Element {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  const revisionId = content.tab.kind === 'document' ? content.tab.revisionId : null;
  useEffect(() => {
    let alive = true;
    const read = () => {
      void bridge
        .invoke('paneDocument', { key: workspaceKey, paneId })
        .then((value) => {
          if (!alive) return;
          const data = value as { revision?: unknown; source?: string; preview?: unknown };
          setWaiting(!data.revision && !data.source && !data.preview);
        })
        .catch((error) => {
          if (alive) setError(String(error));
        });
    };
    read();
    return () => {
      alive = false;
    };
  }, [workspaceKey, paneId, content.artifactId, revisionId, bridge, refreshToken]);
  useEffect(() => {
    if (waiting || !frame.current) {
      register(paneId, null);
      return;
    }
    register(paneId, {
      frame: frame.current,
      artifactId: content.artifactId,
      revisionId,
      paneId,
      key: workspaceKey,
      ready: false,
    });
    return () => register(paneId, null);
  }, [waiting, paneId, workspaceKey, content.artifactId, revisionId, register]);
  if (waiting)
    return (
      <div className="new-tab-home empty-plan-home" onPointerDown={onFocus}>
        <h2>Waiting for your agent</h2>
        <p className="muted">
          This plan is ready as a private workspace. Ask your agent to write and publish its first
          document.
        </p>
        <button className="primary" title={message} onClick={onCopy}>
          Copy message for agent
        </button>
        <button onClick={onNewTab}>New tab</button>
      </div>
    );
  return (
    <>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      <iframe
        ref={frame}
        data-pane-id={paneId}
        sandbox="allow-scripts allow-same-origin"
        className="document-frame"
        title="Projector document"
        src={`projector://document/index.html?surface=1&artifactId=${encodeURIComponent(content.artifactId)}&revisionId=${encodeURIComponent(revisionId ?? '')}&paneId=${encodeURIComponent(paneId)}&shellOrigin=${encodeURIComponent(window.location.origin)}`}
        onLoad={() => {
          if (frame.current)
            register(paneId, {
              frame: frame.current,
              artifactId: content.artifactId,
              revisionId,
              paneId,
              key: workspaceKey,
              ready: true,
            });
        }}
      />
    </>
  );
}
export function BrowserWorkspacePane({
  paneId,
  nativeId,
  error,
  register,
  onFocus,
}: {
  paneId: string;
  nativeId?: string;
  error?: string | null;
  register(paneId: string, value: { nativeId?: string; element: HTMLDivElement } | null): void;
  onFocus(): void;
}): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    register(paneId, element.current ? { nativeId, element: element.current } : null);
    return () => register(paneId, null);
  }, [paneId, nativeId, register]);
  return (
    <>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div
        className="browser-area"
        ref={element}
        data-browser-pane={paneId}
        onPointerDown={onFocus}
      />
    </>
  );
}
export function HomeWorkspacePane({
  address,
  onAddress,
  onOpen,
  busy,
  onFocus,
}: {
  address: string;
  onAddress(value: string): void;
  onOpen(value: string): void;
  busy: boolean;
  onFocus(): void;
}): React.JSX.Element {
  const [value, setValue] = useState(address);
  return (
    <div className="new-tab-home" onPointerDown={onFocus}>
      <h2>New tab</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onOpen(value);
        }}
      >
        <input
          autoFocus
          aria-label="New tab address"
          placeholder="Enter an HTTP or HTTPS URL"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            onAddress(event.target.value);
          }}
        />
        <button className="primary" disabled={busy}>
          Open
        </button>
      </form>
    </div>
  );
}
