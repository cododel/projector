import { test as base, _electron as nativeElectron } from '@playwright/test';
import { DiagnosticCollector } from '../support/diagnostics';
import { unboundConsoleGuard } from '../support/unbound';
import {
  observeChild,
  diagnostic,
  drainDiagnosticChildren,
} from '../../src/shared/test-diagnostics';
let active: DiagnosticCollector | undefined;
const unbound = unboundConsoleGuard('playwright', () => active);
export const test = base.extend<{ diagnostics: DiagnosticCollector }, { unboundDiagnostics: void }>(
  {
    unboundDiagnostics: [
      async ({ playwright }, use) => {
        void playwright;
        try {
          await use();
        } finally {
          try {
            await unbound.assertClean();
          } finally {
            unbound.stop();
          }
        }
      },
      { scope: 'worker', auto: true },
    ],
    diagnostics: [
      async ({ browserName }, use, testInfo) => {
        void browserName;
        const collector = new DiagnosticCollector({
          testId: `${testInfo.testId}/retry${testInfo.retry}/worker${testInfo.workerIndex}`,
        });
        const restore = collector.installEnvironment();
        active = collector;
        collector.phase('test');
        try {
          await use(collector);
        } finally {
          collector.phase('cleanup');
          try {
            await drainDiagnosticChildren();
            await collector.drain();
          } finally {
            active = undefined;
            restore();
            await testInfo.attach('process-diagnostics', {
              path: collector.path,
              contentType: 'application/x-ndjson',
            });
          }
        }
      },
      { auto: true },
    ],
  },
);
export { expect } from '@playwright/test';
export type { ElectronApplication, Page, Locator } from '@playwright/test';
export const electron = {
  async launch(options: Parameters<typeof nativeElectron.launch>[0]) {
    if (!active) throw new Error('Electron launch requires the diagnostic fixture');
    try {
      const env = Object.fromEntries(
        Object.entries({ ...process.env, ...options?.env, ...active.env }).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      if (env.FORCE_COLOR) delete env.NO_COLOR;
      const app = await nativeElectron.launch({ ...options, env });
      observeChild(app.process(), 'main');
      if (
        !active
          .events()
          .some(
            (event) =>
              event.pid === app.process().pid &&
              event.role === 'main' &&
              event.kind === 'process-start',
          )
      )
        throw new Error('Electron diagnostic observer was not installed before readiness');
      const close = app.close.bind(app);
      app.close = async () => {
        active?.phase('cleanup');
        try {
          await close();
        } finally {
          active?.phase('test');
        }
      };
      return app;
    } catch (error) {
      diagnostic('main', 'launch-error', String(error));
      throw error;
    }
  },
};
export function diagnostics(): DiagnosticCollector {
  if (!active) throw new Error('No active diagnostic test');
  return active;
}
