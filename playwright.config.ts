// Test workers enable FORCE_COLOR; avoid the contradictory inherited Node flag.
delete process.env.NO_COLOR;
import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
// Automatic discovery uses an isolated protocol peer, never the operator profile.
process.env.PROJECTOR_E2E_CODEX_EXECUTABLE = resolve('tests/fixtures/codex-cli.mjs');
process.env.CODEX_FIXTURE_EMPTY = '1';

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: resolve('.tmp/test-results', randomUUID()),
  testIgnore: '**/stage-performance.spec.ts',
  // Shard by test, while each runner owns a single native focus session.
  fullyParallel: true,
  workers: 1,
  timeout: 60000,
  use: { trace: 'retain-on-failure' },
});
