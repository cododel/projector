import type { Notification } from '../../src/shared/notifications';

export const makeNotice = (id: string, level: Notification['level'], title: string, body?: string, actions: string[] = []): Notification => ({
  id, source: 'catalog', context: id, operation: id, level, title, body,
  pending: false, repeats: 1, lifetime: 'sticky', actions: actions.map(label => ({ id: label, label })),
});
const info: Notification = { ...makeNotice('info', 'info', 'Operation completed', 'Local changes are confirmed.'), lifetime: 'visible' };
const warning = makeNotice('warning', 'warning', 'Session is in use', 'Close its current Codex process, then try archiving again.', ['Retry']);
const error = makeNotice('error', 'error', 'Operation failed', 'Local storage is unavailable. The existing write needs reconciliation.', ['Confirm local write']);
const undo = makeNotice('undo', 'info', 'Archived chat', 'Review the notification interaction', ['Undo']);
const pending = { ...makeNotice('pending', 'warning', 'Waiting for local storage', 'The operation may complete. Do not repeat it until its result is reconciled.'), pending: true };

/** Shared by the retained standalone storyboard and the Storybook catalog. */
export const notificationFrames = [
  { key: 'empty', name: '00 · Hidden', caption: 'No alerts: no resting capsule or reserved space.', notices: [] },
  { key: 'info', name: '01 · Info', caption: 'Blue frame and icon. No actions: 5 seconds of visible time.', notices: [info] },
  { key: 'warning', name: '02 · Warning', caption: 'Amber frame and icon. Sticky until dismissed or resolved.', notices: [warning] },
  { key: 'error', name: '03 · Error', caption: 'Red frame and icon. Original recovery action stays attached.', notices: [error] },
  { key: 'undo', name: '04 · Undo', caption: 'Informational result with an action stays visible.', notices: [undo] },
  { key: 'pending', name: '05 · Pending', caption: 'Pending is sticky. Dismissal never cancels the operation.', notices: [pending] },
  { key: 'three', name: '06 · Three alerts', caption: 'Newest first, independent actions and contexts, 8 px gaps.', notices: [error, warning, undo] },
  { key: 'overflow', name: '07 · Overflow', caption: 'Only three alerts initially. More opens a scrollable list.', notices: [info, error, warning, undo, pending] },
  { key: 'long', name: '08 · Long content', caption: 'Text wraps. Details expand inside the same alert.', notices: [{ ...error, body: 'This notification belongs to the original project and operation. '.repeat(5), details: '/example/workspace\nWrite confirmation failed; reconcile the existing operation before retrying.' }] },
] satisfies { key: string; name: string; caption: string; notices: Notification[] }[];
