import { afterEach, expect, it, vi } from 'vitest';
import { HarnessSync } from '../src/main/harness-sync';
afterEach(() => vi.useRealTimers());
it('synchronizes immediately, coalesces refreshes, retries errors and stops future polling', async () => {
  vi.useFakeTimers();
  let finish: () => void = () => {};
  const synchronize = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const sync = new HarnessSync(synchronize);
  sync.start();
  await Promise.resolve();
  expect(synchronize).toHaveBeenCalledTimes(1);
  const a = sync.refresh(),
    b = sync.refresh();
  expect(a).toBe(b);
  await vi.advanceTimersByTimeAsync(30000);
  expect(synchronize).toHaveBeenCalledTimes(1);
  finish();
  await a;
  await vi.advanceTimersByTimeAsync(15000);
  expect(synchronize).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(15000);
  expect(synchronize).toHaveBeenCalledTimes(3);
  sync.stop();
  await vi.advanceTimersByTimeAsync(60000);
  expect(synchronize).toHaveBeenCalledTimes(3);
});
it('does not schedule another discovery when stopped during an in-flight read', async () => {
  vi.useFakeTimers();
  let finish: () => void = () => {};
  const synchronize = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const sync = new HarnessSync(synchronize);
  sync.start();
  await Promise.resolve();
  sync.stop();
  finish();
  await sync.settled();
  await vi.advanceTimersByTimeAsync(60000);
  expect(synchronize).toHaveBeenCalledTimes(1);
  await expect(sync.refresh()).rejects.toThrow('stopped');
});
