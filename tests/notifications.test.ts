import { expect, it, vi } from 'vitest';
import { NotificationController, type NotificationInput } from '../src/renderer/notifications';
import { notificationsSchema, VisibleLifetime } from '../src/shared/notifications';

const first: NotificationInput = { source: 'archive', context: 'thread-a/profile-a', operation: 'archive', level: 'warning', title: 'Session is in use' };
it('deduplicates only exact event identity; independent sessions/profiles retain independent actions', async () => {
  const store = new NotificationController(); const undoA = vi.fn(), undoB = vi.fn();
  const a = store.push({ ...first, actions: [{ label: 'Undo', run: undoA }] });
  const b = store.push({ ...first, context: 'thread-b/profile-b', actions: [{ label: 'Undo', run: undoB }] });
  const same = store.push({ ...first, actions: [{ label: 'Retry', run: undoA }] });
  expect(same).toBe(a); expect(store.snapshot().map(n => n.id)).toEqual([b, a]);
  expect(store.snapshot().find(n => n.id === a)?.repeats).toBe(2);
  store.update(a, { level: 'info', title: 'Archived chat', actions: [{ label: 'Undo', run: undoA }] });
  expect(store.snapshot().find(n => n.id === a)?.level).toBe('info');
  store.push({ ...first, context: 'thread-a/profile-other' });
  expect(store.snapshot()).toHaveLength(3);
  await store.run(b, store.snapshot().find(n => n.id === b)!.actions[0].id);
  expect(undoB).toHaveBeenCalledTimes(1); expect(undoA).not.toHaveBeenCalled();
});
it('blocks double invocation and stale actions; dismissal never replays an unresolved write', async () => {
  const store = new NotificationController(); let finish!: () => void;
  const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const id = store.push({ ...first, actions: [{ label: 'Confirm', run }] });
  const action = store.snapshot()[0].actions[0].id;
  const ongoing = store.run(id, action);
  await store.run(id, action); expect(run).toHaveBeenCalledTimes(1);
  store.dismiss(id); expect(store.snapshot()).toHaveLength(0);
  finish(); await ongoing; await store.run(id, action);
  expect(run).toHaveBeenCalledTimes(1); expect(store.snapshot()).toHaveLength(0);
});
it('action failure stays attached to its original operation and does not automatically retry', async () => {
  const store = new NotificationController(); const run = vi.fn(() => { throw new Error('PROFILE_CHANGED'); });
  const id = store.push({ ...first, actions: [{ label: 'Undo', run }] });
  const action = store.snapshot()[0].actions[0].id;
  await store.run(id, action);
  expect(store.snapshot()[0]).toMatchObject({ id, context: first.context, operation: first.operation, level: 'error', body: 'PROFILE_CHANGED', pending: false, lifetime: 'sticky' });
  expect(run).toHaveBeenCalledTimes(1);
  store.update(id, { actions: [] }); await store.run(id, action); expect(run).toHaveBeenCalledTimes(1);
});
it('counts five seconds of visible time only across hover, focus, hidden and offscreen pauses', () => {
  const clock = new VisibleLifetime();
  expect(clock.update(0, true)).toBe(5000);
  expect(clock.update(1200, false)).toBe(3800);
  expect(clock.update(20000, true)).toBe(3800);
  expect(clock.update(21000, false)).toBe(2800);
  expect(clock.update(40000, false)).toBe(2800);
  expect(clock.update(50000, true)).toBe(2800);
  expect(clock.update(52800, true)).toBe(0);
});
it('serializes opaque action IDs only and rejects foreign functions/commands', () => {
  const store = new NotificationController(); store.push({ ...first, actions: [{ label: 'Undo', run: () => {} }] });
  expect(notificationsSchema.safeParse(store.snapshot()).success).toBe(true);
  const notice = store.snapshot()[0];
  expect(notificationsSchema.safeParse([{ ...notice, actions: [{ ...notice.actions[0], run: () => {} }] }]).success).toBe(false);
  const many = Array.from({ length: 1001 }, (_, i) => ({ ...notice, id: `notice-${i}` }));
  expect(notificationsSchema.safeParse(many).success).toBe(true);
});
