import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { Notification } from '../shared/notifications';
import type { NotificationTransport } from '../shared/notifications';
import { notifications } from './notifications';
import { useNotifyError } from './NotificationContext';

export function useNotificationHost(transport: NotificationTransport | undefined, onPublished?: (snapshot: Notification[]) => void): number {
  const published = useRef(onPublished); published.current = onPublished;
  const notices = useSyncExternalStore(notifications.subscribe, notifications.snapshot);
  useEffect(() => {
    if (!transport) return;
    let retired = false;
    let writes = Promise.resolve();
    const publish = () => {
      const snapshot = notifications.snapshot();
      writes = writes.then(async () => {
        if (!retired) {
          await transport.publish(snapshot);
          if (!retired) published.current?.(snapshot);
        }
      }).catch(error => {
        if (!retired) console.error('Notification transport failed', error);
      });
    };
    publish();
    const unsubscribe = notifications.subscribe(publish);
    const uncommand = transport.onCommand(command => {
      if (command.type === 'dismiss') notifications.dismiss(command.id);
      else if (command.type === 'action') void notifications.run(command.id, command.actionId);
    });
    return () => { retired = true; unsubscribe(); uncommand(); };
  }, [transport]);
  return notices.length;
}

/** Callers own operation guards; dismissing presentation cannot change them. */
export function useErrorReporter(source: string, context: string): (error: string) => string | null {
  const report = useNotifyError();
  return useCallback(value => value ? report(value, source, context) : null, [report, source, context]);
}
