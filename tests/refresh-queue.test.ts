import { expect, test, vi } from 'vitest';
import { RefreshQueue } from '../src/renderer/refresh-queue';

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  return { ready, release };
}

test('a burst has one active reader and a late update replaces the stale result', async () => {
  const entered = gate(),
    blocked = gate();
  let value = 'old',
    shown = '',
    active = 0,
    maximum = 0,
    reads = 0;
  const errors = vi.fn();
  const refresh = new RefreshQueue(async (isCurrent) => {
    active++;
    maximum = Math.max(maximum, active);
    const received = value;
    if (++reads === 1) {
      entered.release();
      await blocked.ready;
    }
    if (isCurrent()) shown = received;
    active--;
  }, errors);
  const done = refresh.request();
  await entered.ready;
  value = 'latest';
  for (let i = 0; i < 10; i++) refresh.invalidate();
  expect(shown).toBe('');
  blocked.release();
  await done;
  expect(shown).toBe('latest');
  expect(maximum).toBe(1);
  expect(reads).toBe(2);
  expect(errors).not.toHaveBeenCalled();
});

test('notifications and action waiters survive nested write/transition pauses', async () => {
  const read = vi.fn(async () => undefined),
    refresh = new RefreshQueue(read, vi.fn());
  const finishTransition = refresh.pause(),
    finishWrite = refresh.pause();
  const done = refresh.request();
  refresh.invalidate();
  finishTransition();
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
  finishWrite();
  finishWrite();
  await done;
  expect(read).toHaveBeenCalledTimes(1);
});

test('pausing an active read prevents stale commit and resumes with fresh data', async () => {
  const entered = gate(),
    blocked = gate();
  let reads = 0,
    shown = 0;
  const refresh = new RefreshQueue(async (isCurrent) => {
    const version = ++reads;
    if (version === 1) {
      entered.release();
      await blocked.ready;
    }
    if (isCurrent()) shown = version;
  }, vi.fn());
  const done = refresh.request();
  await entered.ready;
  const resume = refresh.pause();
  blocked.release();
  await Promise.resolve();
  expect(shown).toBe(0);
  resume();
  await done;
  expect(shown).toBe(2);
});

test('a read failure reaches action callers and does not prevent subsequent updates', async () => {
  let fail = true,
    shown = false;
  const error = new Error('Runtime unavailable'),
    errors = vi.fn();
  const refresh = new RefreshQueue(async () => {
    if (fail) throw error;
    shown = true;
  }, errors);
  await expect(refresh.request()).rejects.toThrow('Runtime unavailable');
  expect(errors).toHaveBeenCalledWith(error);
  fail = false;
  await refresh.request();
  expect(shown).toBe(true);
});
