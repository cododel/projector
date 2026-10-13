import './notifications-storyboard.css';
import React, { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { NotificationStack } from '../src/renderer/NotificationStack';
import { NotificationController } from '../src/renderer/notifications';
import type { Notification, NotificationOverlayBridge } from '../src/shared/notifications';

const staticBridge: NotificationOverlayBridge = { command() {}, onState: () => () => {}, onFocus: () => () => {} };
const notice = (id: string, level: Notification['level'], title: string, body?: string, actions: string[] = []): Notification => ({ id, source: 'storyboard', context: id, operation: id, level, title, body, pending: false, repeats: 1, lifetime: 'sticky', actions: actions.map(label => ({ id: label, label })) });
const info = notice('info', 'info', 'Operation completed', 'Local changes are confirmed.');
const warning = notice('warning', 'warning', 'Session is in use', 'Close its current Codex process, then try archiving again.', ['Retry']);
const error = notice('error', 'error', 'Operation failed', 'Local storage is unavailable. The existing write needs reconciliation.', ['Confirm local write']);
const undo = notice('undo', 'info', 'Archived chat', 'Review the notification interaction', ['Undo']);
const pending = { ...notice('pending', 'warning', 'Waiting for local storage', 'The operation may complete. Do not repeat it until its result is reconciled.'), pending: true };
const frames: { name: string; caption: string; notices: Notification[] }[] = [
  { name: '00 · Hidden', caption: 'No alerts: no resting capsule or reserved space.', notices: [] },
  { name: '01 · Info', caption: 'Blue frame and icon. No actions: 5 seconds of visible time.', notices: [info] },
  { name: '02 · Warning', caption: 'Amber frame and icon. Sticky until dismissed or resolved.', notices: [warning] },
  { name: '03 · Error', caption: 'Red frame and icon. Original recovery action stays attached.', notices: [error] },
  { name: '04 · Undo', caption: 'Informational result with an action stays visible.', notices: [undo] },
  { name: '05 · Pending', caption: 'Pending is sticky. Dismissal never cancels the operation.', notices: [pending] },
  { name: '06 · Three alerts', caption: 'Newest first, independent actions and contexts, 8 px gaps.', notices: [error, warning, undo] },
  { name: '07 · Overflow', caption: 'Only three alerts initially. More opens a scrollable list.', notices: [info, error, warning, undo, pending] },
  { name: '08 · Long content', caption: 'Text wraps. Details expand inside the same alert.', notices: [{ ...error, body: 'This notification belongs to the original project and operation. '.repeat(5), details: '/project/workspace\nWrite confirmation failed; reconcile the existing operation before retrying.' }] },
];
const demo = new NotificationController();
const demoBridge: NotificationOverlayBridge = { ...staticBridge, command(command) {
  if (command.type === 'dismiss') demo.dismiss(command.id);
  if (command.type === 'action') void demo.run(command.id, command.actionId);
} };
function push(level: Notification['level']) {
  const operation = crypto.randomUUID();
  const id = demo.push({ source: 'demo', context: 'local demo only', operation, level,
    title: level === 'info' ? 'Operation completed' : level === 'warning' ? 'Session is in use' : 'Operation failed',
    body: level === 'info' ? 'This info disappears after 5 visible seconds.' : 'Demonstration only: no sessions or files are changed.', lifetime: level === 'info' ? 'visible' : 'sticky',
    actions: level === 'warning' ? [{ label: 'Retry', pendingLabel: 'Retrying…', run: async () => {
      await new Promise(resolve => setTimeout(resolve, 900));
      demo.update(id, { level: 'info', title: 'Archived chat', body: 'The same operation now has an independent Undo.', actions: [{ label: 'Undo', run: () => 'dismiss' }] });
      return 'keep' as const;
    } }] : undefined });
}
function App() {
  const current = useSyncExternalStore(demo.subscribe, demo.snapshot);
  return <main><header><small>PROJECTOR · NOTIFICATION STORYBOARD</small><h1>Stackable alerts</h1><p>Black pills. Color identifies severity. Every alert owns its state and actions.</p></header>
    <section className="live"><div><h2>Interactive states</h2><p>Entry / exit 180 ms · resize / reflow 220 ms · reduced motion supported.</p><div className="controls"><button onClick={() => push('info')}>Info</button><button onClick={() => push('warning')}>Warning → Undo</button><button onClick={() => push('error')}>Error</button><button onClick={() => current.forEach(n => demo.dismiss(n.id))}>Clear</button></div></div><div className="live-stage"><NotificationStack notifications={current} visible maxHeight={480} bridge={demoBridge} />{!current.length && <p className="empty">Add an alert to explore motion and timing.</p>}</div></section>
    <div className="story-grid">{frames.map(frame => <section className="frame" key={frame.name}><h2>{frame.name}</h2><p>{frame.caption}</p><div className="frame-stage"><NotificationStack notifications={frame.notices} visible={false} maxHeight={440} bridge={staticBridge} />{!frame.notices.length && <p className="empty">The overlay is hidden.</p>}</div></section>)}</div>
    <footer>Storyboard renders the production NotificationStack. Static frames pause timers; interactive states use the production controller and lifetime rules. Native Electron pointer routing requires separate desktop validation.</footer></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
