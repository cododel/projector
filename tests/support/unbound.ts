import { randomUUID } from 'node:crypto';
import { DiagnosticCollector } from './diagnostics';
import { diagnostic } from '../../src/shared/test-diagnostics';

const slot = Symbol.for('projector.test.console-diagnostic-route');
type Route = (message: string) => void;
interface ConsoleRouter {
  original: typeof console.error;
  wrapper: typeof console.error;
  route?: Route;
}
type RoutedConsole = typeof console & { [slot]?: ConsoleRouter };

/** One route, never a chain of stale setup-file wrappers across Vitest files. */
export function unboundConsoleGuard(runner: string, active: () => DiagnosticCollector | undefined) {
  const collector = new DiagnosticCollector({
    testId: `unbound:${runner}:${process.pid}:${randomUUID()}`,
  });
  collector.phase('unbound');
  const target = console as RoutedConsole;
  let router = target[slot];
  if (!router || console.error !== router.wrapper) {
    const original = console.error;
    router = { original, wrapper: () => {} };
    const installed = router;
    installed.wrapper = (...args: unknown[]) => {
      installed.route?.(args.map(String).join(' '));
      installed.original(...args);
    };
    target[slot] = installed;
    console.error = installed.wrapper;
  }
  const route: Route = (message) => {
    const owner = active() ?? collector;
    diagnostic('test-runner', 'console-error', message, 'error', {
      context: { ...process.env, ...owner.env },
    });
  };
  router.route = route;
  return {
    collector,
    async assertClean() {
      await collector.drain();
    },
    stop() {
      // A subsequent setup file owns the slot if it has installed a new route.
      if (router.route !== route) return;
      router.route = undefined;
      if (console.error === router.wrapper) console.error = router.original;
      if (target[slot] === router) delete target[slot];
    },
  };
}
