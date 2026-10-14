import React, { useId } from 'react';
import { Icon } from '../Icon';
import type { TerminalRecord } from '../../shared/terminal';
export function BottomTerminals({
  height,
  tabs,
  activeTerminalId,
  terminals,
  busy,
  resizer,
  children,
  onSelect,
  onClose,
  onNew,
  onHide,
}: {
  height: number;
  tabs: string[];
  activeTerminalId: string | null;
  terminals: TerminalRecord[];
  busy: boolean;
  resizer: React.ReactNode;
  children: React.ReactNode;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onHide: () => void;
}) {
  const owner = useId();
  return (
    <section className="project-terminal-panel" style={{ height }} aria-label="Project terminals">
      {resizer}
      <nav className="bottom-terminal-tabs" aria-label="Project terminal controls">
        {tabs.length > 0 && (
          <div
            role="tablist"
            aria-label="Project terminal tabs"
            aria-owns={tabs.map((id) => `${owner}-${id}`).join(' ')}
            style={{ display: 'contents' }}
          />
        )}
        {tabs.map((id) => {
          const record = terminals.find((record) => record.id === id);
          return (
            <div className={activeTerminalId === id ? 'active' : ''} key={id}>
              <button
                id={`${owner}-${id}`}
                role="tab"
                aria-selected={activeTerminalId === id}
                onClick={() => onSelect(id)}
              >
                {record?.title ?? 'Terminal'}
              </button>
              <button
                aria-label={`Close ${record?.title ?? 'project terminal'} view`}
                onClick={() => onClose(id)}
              >
                <Icon name="close" />
              </button>
            </div>
          );
        })}
        <button aria-label="New project terminal" disabled={busy} onClick={onNew}>
          <Icon name="plus" />
        </button>
        <button className="bottom-hide" aria-label="Hide project terminals" onClick={onHide}>
          <Icon name="down" />
        </button>
      </nav>
      {children}
    </section>
  );
}
export function BottomResizer({
  height,
  ...handlers
}: { height: number } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className="bottom-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="Resize project terminals"
      aria-valuemin={120}
      aria-valuemax={800}
      aria-valuenow={height}
      {...handlers}
    />
  );
}
