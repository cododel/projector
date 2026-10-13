import React from 'react';

export interface ArchivedChat {
  notificationId: string;
  id: string;
  title: string;
  executable: string;
  profile: string;
}
export function SessionActions({
  title,
  pinned,
  pending,
  onPin,
  onArchive,
}: {
  title: string;
  pinned: boolean;
  pending: boolean;
  onPin: () => void;
  onArchive: () => void;
}): React.JSX.Element {
  return (
    <span className="session-actions">
      <button
        className={pinned ? 'session-pinned' : ''}
        aria-label={`${pinned ? 'Unpin' : 'Pin'} ${title}`}
        title={pinned ? 'Unpin' : 'Pin'}
        aria-pressed={pinned}
        disabled={pending}
        onClick={onPin}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <path d="m16 3 5 5-4 3-1 5-3 1-6-6 1-3zM9 15l-6 6" />
        </svg>
      </button>
      <button
        aria-label={`Archive ${title}`}
        title="Archive"
        disabled={pending}
        onClick={onArchive}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        >
          <rect x="3" y="3" width="18" height="4" rx="1" />
          <path d="M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7M9 11h6" />
        </svg>
      </button>
    </span>
  );
}
