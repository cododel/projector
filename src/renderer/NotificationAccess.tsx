import React, { useSyncExternalStore } from 'react';
import { useNotificationEnvironment } from './NotificationContext';

/** Also reachable inside dialogs whose Tab order is intentionally trapped. */
export function NotificationAccess(): React.JSX.Element | null {
  const { controller: notifications, transport } = useNotificationEnvironment();
  const notices = useSyncExternalStore(notifications.subscribe, notifications.snapshot);
  return notices.length && transport ? <button type="button" className="notification-access" onClick={() => transport.focus()}>Notifications · {notices.length}</button> : null;
}
