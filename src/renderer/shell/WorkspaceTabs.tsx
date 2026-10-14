import React, { useId } from 'react';
import { Icon } from '../Icon';
export interface WorkspaceTabItem {
  id: string;
  title: string;
  tooltip?: string;
  glyph: string;
  pinned: boolean;
  active: boolean;
  count?: number;
  closeLabel: string;
}
export function WorkspaceTabs({
  items,
  label,
  busy,
  visible = true,
  tabsRef,
  onSelect,
  onClose,
}: {
  items: WorkspaceTabItem[];
  label: string;
  busy: boolean;
  visible?: boolean;
  tabsRef?: React.Ref<HTMLElement>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const owner = useId();
  if (!visible) return null;
  return (
    <nav className="content-tabs" aria-label={label} ref={tabsRef} tabIndex={busy ? 0 : undefined}>
      {items.length > 0 && (
        <div
          role="tablist"
          aria-label={label}
          aria-owns={items.map((tab) => `${owner}-${tab.id}`).join(' ')}
          style={{ display: 'contents' }}
        />
      )}
      {items.map((tab) => (
        <div className={`content-tab ${tab.active ? 'active' : ''}`} key={tab.id}>
          <button
            id={`${owner}-${tab.id}`}
            role="tab"
            aria-selected={tab.active}
            disabled={busy}
            title={tab.tooltip}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                if (!tab.pinned) onClose(tab.id);
              }
            }}
            onClick={() => onSelect(tab.id)}
          >
            <span aria-hidden="true">{tab.glyph}</span>
            <span>
              {tab.title}
              {(tab.count ?? 0) > 1 ? ` · ${tab.count}` : ''}
            </span>
          </button>
          {!tab.pinned && (
            <button
              className="tab-close"
              disabled={busy}
              aria-label={tab.closeLabel}
              onClick={() => onClose(tab.id)}
            >
              <Icon name="close" />
            </button>
          )}
        </div>
      ))}
    </nav>
  );
}
