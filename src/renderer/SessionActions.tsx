import { Icon } from './Icon';
import React, { useEffect, useState } from 'react';

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
export function ArchiveNotice({
  chat,
  onUndo,
  onDismiss,
}: {
  chat: ArchivedChat;
  onUndo: (chat: ArchivedChat) => Promise<void>;
  onDismiss: () => void;
}): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(onDismiss, 180);
    return () => clearTimeout(timer);
  }, [closing, onDismiss]);
  return (
    <div className={`archive-notice ${closing ? 'closing' : ''}`} role="status" aria-live="polite">
      <svg
        aria-hidden="true"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <rect x="3" y="3" width="18" height="4" rx="1" />
        <path d="M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7M9 11h6" />
      </svg>
      <span title={chat.title}>Archived chat</span>
      <button
        disabled={pending || closing}
        onClick={() => {
          setPending(true);
          setError('');
          void onUndo(chat)
            .then(() => setClosing(true))
            .catch((failure: unknown) => {
              setError(failure instanceof Error ? failure.message : String(failure));
            })
            .finally(() => setPending(false));
        }}
      >
        {pending ? 'Undoing…' : 'Undo'}
      </button>
      <button
        className="notice-dismiss"
        aria-label="Dismiss archive notification"
        disabled={pending}
        onClick={() => setClosing(true)}
      >
        <Icon name="close" />
      </button>
      {error && (
        <span className="archive-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
