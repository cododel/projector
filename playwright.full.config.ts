// Test workers enable FORCE_COLOR; avoid the contradictory inherited Node flag.
delete process.env.NO_COLOR;
import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.PROJECTOR_E2E_VISIBLE = '1';
process.env.PROJECTOR_E2E_BACKGROUND = '0';
process.env.PROJECTOR_CODEX_TEST = '1';

// Automatic discovery uses an isolated protocol peer, never the operator profile.
process.env.PROJECTOR_E2E_CODEX_EXECUTABLE = resolve('tests/fixtures/codex-cli.mjs');
process.env.CODEX_FIXTURE_EMPTY = '1';

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: resolve('.tmp/test-results', randomUUID()),
  // This guarantee requires inactive windows and is run separately by check:full.
  testIgnore: ['**/background.spec.ts', '**/stage-performance.spec.ts'],
  workers: 1,
  timeout: 60000,
  reporter: [['list'], ['./tests/e2e/no-skips-reporter.ts']],
  use: { trace: 'retain-on-failure' },
});
