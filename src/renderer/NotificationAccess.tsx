import React, { useSyncExternalStore } from 'react';
import { notifications } from './notifications';
import type { NotificationTransport } from '../shared/notifications';

/** Also reachable inside dialogs whose Tab order is intentionally trapped. */
export function NotificationAccess(): React.JSX.Element | null {
  const notices = useSyncExternalStore(notifications.subscribe, notifications.snapshot);
  const transport = (window as unknown as { projector?: { notifications?: NotificationTransport } }).projector?.notifications;
  return notices.length && transport ? <button type="button" className="notification-access" onClick={() => transport.focus()}>Notifications · {notices.length}</button> : null;
}
