import React from 'react';
import { Icon } from '../Icon';
export function SidebarUtilities({
  onSettings,
  onGuide,
  onMcp,
}: {
  onSettings: () => void;
  onGuide: () => void;
  onMcp: () => void;
}) {
  return (
    <nav className="sidebar-bottom" aria-label="Application utilities">
      <button className="sidebar-utility" onClick={onSettings}>
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>Settings</span>
      </button>
      <button className="sidebar-utility" onClick={onGuide}>
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M4 3h12a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2V3Zm0 14h14M8 7h6M8 10h6" />
        </svg>
        <span>Projector guide</span>
      </button>
      <button
        className="sidebar-utility"
        aria-label="MCP connection"
        title="MCP connection · Local runtime active"
        onClick={onMcp}
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4" />
        </svg>
        <span>MCP connection</span>
        <span className="runtime-dot footer-runtime" role="img" aria-label="Local runtime active" />
      </button>
    </nav>
  );
}

export function SidebarToggle({
  side,
  visible,
  disabled = false,
  onToggle,
}: {
  side: 'left' | 'right';
  visible: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const label = `${visible ? 'Hide' : 'Show'} ${side === 'left' ? 'projects' : 'feedback'} sidebar`;
  return (
    <button
      className="sidebar-toggle"
      aria-label={label}
      title={label}
      aria-pressed={visible}
      disabled={disabled}
      onClick={onToggle}
    >
      <Icon name={side === 'left' ? 'sidebar-left' : 'sidebar-right'} />
    </button>
  );
}
