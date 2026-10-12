import React from 'react';

export function Icon({
  name,
}: {
  name:
    | 'edit'
    | 'delete'
    | 'folder'
    | 'sidebar-left'
    | 'sidebar-right'
    | 'more'
    | 'plus'
    | 'refresh'
    | 'close'
    | 'back'
    | 'forward'
    | 'external'
    | 'split-right'
    | 'split-down'
    | 'terminal'
    | 'down'
    | 'right'
    | 'stop';
}): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === 'more' ? (
        <g fill="currentColor" stroke="none">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </g>
      ) : name === 'plus' ? (
        <path d="M12 5v14M5 12h14" />
      ) : name === 'close' ? (
        <path d="m6 6 12 12M6 18 18 6" />
      ) : name === 'refresh' ? (
        <path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6" />
      ) : name === 'back' ? (
        <path d="M20 12H4m6-6-6 6 6 6" />
      ) : name === 'forward' ? (
        <path d="M4 12h16m-6-6 6 6-6 6" />
      ) : name === 'external' ? (
        <path d="M5 19 19 5M8 5h11v11" />
      ) : name === 'split-right' || name === 'split-down' ? (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d={name === 'split-right' ? 'M12 4v16' : 'M3 12h18'} />
        </>
      ) : name === 'terminal' ? (
        <path d="m4 6 6 6-6 6m9 0h7" />
      ) : name === 'down' ? (
        <path d="m6 9 6 6 6-6" />
      ) : name === 'right' ? (
        <path d="m9 6 6 6-6 6" />
      ) : name === 'stop' ? (
        <rect x="6" y="6" width="12" height="12" rx="1" />
      ) : name === 'sidebar-left' || name === 'sidebar-right' ? (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d={name === 'sidebar-left' ? 'M9 4v16' : 'M15 4v16'} />
        </>
      ) : name === 'edit' ? (
        <path d="m16 3 5 5-13 13H3v-5L16 3ZM13 6l5 5" />
      ) : name === 'folder' ? (
        <path d="M3 7V5h6l2 2h10v13H3V7Z" />
      ) : (
        <>
          <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
        </>
      )}
    </svg>
  );
}
