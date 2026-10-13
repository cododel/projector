import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { NotificationOverlayBridge } from '../shared/notifications';
import { NotificationStack } from './NotificationStack';

const bridge = (window as unknown as { projectorNotifications: NotificationOverlayBridge }).projectorNotifications;
function App(): React.JSX.Element {
  const [state, setState] = useState<Parameters<Parameters<typeof bridge.onState>[0]>[0]>({ notifications: [], visible: false, maxHeight: 540 });
  useEffect(() => {
    const dispose = bridge.onState(setState);
    const unfocus = bridge.onFocus(() => document.querySelector<HTMLButtonElement>('.notification-stack button')?.focus());
    bridge.command({ type: 'ready' });
    const pointer = (event: MouseEvent) => bridge.command({ type: 'pointer', interactive: Boolean((event.target as Element).closest('.notification-alert, .notification-overflow')) });
    window.addEventListener('mousemove', pointer);
    return () => { dispose(); unfocus(); window.removeEventListener('mousemove', pointer); };
  }, []);
  return <NotificationStack {...state} bridge={bridge} />;
}
createRoot(document.getElementById('root')!).render(<App />);
