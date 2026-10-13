import { beforeEach, afterEach, afterAll } from 'vitest';
import { DiagnosticCollector } from './diagnostics';
import { drainDiagnosticChildren } from '../../src/shared/test-diagnostics';
import { unboundConsoleGuard } from './unbound';
let current: DiagnosticCollector | undefined;
let restore: (() => void) | undefined;
const unbound = unboundConsoleGuard('vitest', () => current);
// Vitest stack hook order runs this first-registered hook after user afterAll.
afterAll(async () => {
  try {
    await unbound.assertClean();
  } finally {
    unbound.stop();
  }
});
beforeEach((context) => {
  if (process.env.FORCE_COLOR) delete process.env.NO_COLOR;
  current = new DiagnosticCollector({ testId: context.task.id + ':' + context.task.name });
  restore = current.installEnvironment();
  current.phase('test');
});
afterEach(async () => {
  current?.phase('cleanup');
  try {
    await drainDiagnosticChildren();
    await current?.drain();
  } finally {
    restore?.();
    current = undefined;
  }
});
export function diagnostics(): DiagnosticCollector {
  if (!current) throw new Error('No active diagnostic test');
  return current;
}
