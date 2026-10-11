import React, { useEffect, useRef, useState } from 'react';
import type { PaneNode } from '../shared/application-workspace';

export function WorkspaceSplit({
  node,
  activePaneId,
  renderPane,
  onRatio,
  onResizeMode,
}: {
  node: PaneNode;
  activePaneId: string | null;
  renderPane(pane: Extract<PaneNode, { kind: 'pane' }>, active: boolean): React.ReactNode;
  onRatio(splitId: string, ratio: number): Promise<unknown>;
  onResizeMode?(active: boolean): void;
}): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const pointer = useRef<{ id: number; ratio: number } | null>(null);
  const resizeMode = useRef(onResizeMode);
  resizeMode.current = onResizeMode;
  useEffect(
    () => () => {
      if (pointer.current) resizeMode.current?.(false);
    },
    [],
  );
  if (node.kind === 'pane')
    return (
      <div
        className={`workspace-pane ${node.id === activePaneId ? 'active' : ''}`}
        data-workspace-pane={node.id}
      >
        {renderPane(node, node.id === activePaneId)}
      </div>
    );
  const ratio = preview ?? node.ratio;
  const horizontal = node.axis === 'horizontal';
  return (
    <div className={`workspace-split ${horizontal ? 'horizontal' : 'vertical'}`} ref={element}>
      <div className="split-child" style={{ flex: `${ratio} 1 0` }}>
        <WorkspaceSplit
          key={node.first.id}
          node={node.first}
          activePaneId={activePaneId}
          renderPane={renderPane}
          onRatio={onRatio}
          onResizeMode={onResizeMode}
        />
      </div>
      <div
        className="pane-divider"
        role="separator"
        tabIndex={0}
        aria-label="Resize split panels"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-valuemin={10}
        aria-valuemax={90}
        aria-valuenow={Math.round(ratio * 100)}
        onPointerDown={(event) => {
          pointer.current = { id: event.pointerId, ratio };
          onResizeMode?.(true);
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (!pointer.current || pointer.current.id !== event.pointerId || !element.current)
            return;
          const rect = element.current.getBoundingClientRect();
          const value = Math.max(
            0.1,
            Math.min(
              0.9,
              horizontal
                ? (event.clientX - rect.x) / rect.width
                : (event.clientY - rect.y) / rect.height,
            ),
          );
          pointer.current.ratio = value;
          setPreview(value);
        }}
        onPointerUp={(event) => {
          const drag = pointer.current;
          if (!drag) return;
          pointer.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
          void onRatio(node.id, drag.ratio).finally(() => {
            setPreview(null);
            onResizeMode?.(false);
          });
        }}
        onPointerCancel={() => {
          pointer.current = null;
          setPreview(null);
          onResizeMode?.(false);
        }}
        onKeyDown={(event) => {
          const offset = ['ArrowRight', 'ArrowDown'].includes(event.key)
            ? 0.05
            : ['ArrowLeft', 'ArrowUp'].includes(event.key)
              ? -0.05
              : 0;
          if (offset) {
            event.preventDefault();
            void onRatio(node.id, Math.max(0.1, Math.min(0.9, node.ratio + offset)));
          }
        }}
      />
      <div className="split-child" style={{ flex: `${1 - ratio} 1 0` }}>
        <WorkspaceSplit
          key={node.second.id}
          node={node.second}
          activePaneId={activePaneId}
          renderPane={renderPane}
          onRatio={onRatio}
          onResizeMode={onResizeMode}
        />
      </div>
    </div>
  );
}
