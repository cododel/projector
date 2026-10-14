import './notification-host.css';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { NotificationOverlayBridge } from '../shared/notifications';
import { NotificationStack } from './NotificationStack';

const bridge = (window as unknown as { projectorNotifications: NotificationOverlayBridge }).projectorNotifications;
function App(): React.JSX.Element {
  const [state, setState] = useState<Parameters<Parameters<typeof bridge.onState>[0]>[0]>({ notifications: [], visible: false, maxHeight: 540 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  useEffect(() => {
    const dispose = bridge.onState(setState);
    const unfocus = bridge.onFocus(() => document.querySelector<HTMLButtonElement>('.notification-stack button')?.focus());
    bridge.command({ type: 'ready' });
    let interactive = false;
    const hit = (target: Element | null) => {
      const alert = target?.closest('.notification-alert:not(.leaving)');
      setHoveredId(alert?.getAttribute('data-notification-id') ?? null);
      const next = Boolean(alert || target?.closest('.notification-overflow'));
      if (next !== interactive) { interactive = next; bridge.command({ type: 'pointer', interactive }); }
    };
    const unpointer = bridge.onPointer(point => hit(document.elementFromPoint(point.x, point.y)));
    const pointer = (event: MouseEvent) => hit(event.target as Element);
    window.addEventListener('mousemove', pointer);
    return () => { dispose(); unfocus(); unpointer(); window.removeEventListener('mousemove', pointer); };
  }, []);
  return <NotificationStack {...state} hoveredId={hoveredId} bridge={bridge} />;
}
createRoot(document.getElementById('root')!).render(<App />);
