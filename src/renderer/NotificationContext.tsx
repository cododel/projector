import React, { createContext, useContext, useCallback } from 'react';
import type { NotificationTransport } from '../shared/notifications';
import { notifications, NotificationController, notifyError } from './notifications';

interface Environment { controller: NotificationController; transport?: NotificationTransport }
const Context = createContext<Environment | null>(null);
/** Input-only environment seam: product defaults retain their existing controller/bridge. */
export function NotificationProvider({ controller, transport, children }: Environment & { children: React.ReactNode }): React.JSX.Element {
  return <Context.Provider value={{ controller, transport }}>{children}</Context.Provider>;
}
export function useNotificationEnvironment(): Environment {
  const isolated = useContext(Context);
  return isolated ?? { controller: notifications, transport: (window as unknown as { projector?: { notifications?: NotificationTransport } }).projector?.notifications };
}
export function useNotifyError(): typeof notifyError {
  const { controller } = useNotificationEnvironment();
  return useCallback((error, source, context, operation = crypto.randomUUID()) => controller.push({
    source, context, operation, level: 'error', title: 'Operation failed',
    body: error instanceof Error ? error.message : String(error),
  }), [controller]);
}
