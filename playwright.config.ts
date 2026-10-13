// Test workers enable FORCE_COLOR; avoid the contradictory inherited Node flag.
delete process.env.NO_COLOR;
import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';

// Direct `playwright test` and opt-in Codex tests use the same safe default.
process.env.PROJECTOR_E2E_BACKGROUND = process.env.PROJECTOR_E2E_VISIBLE === '1' ? '0' : '1';
const background = process.env.PROJECTOR_E2E_BACKGROUND === '1';

// Automatic discovery uses an isolated protocol peer, never the operator profile.
process.env.PROJECTOR_E2E_CODEX_EXECUTABLE = resolve('tests/fixtures/codex-cli.mjs');
process.env.CODEX_FIXTURE_EMPTY = '1';

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: resolve('.tmp/test-results', randomUUID()),
  testIgnore: '**/stage-performance.spec.ts',
  // Hidden scenarios have disposable app data, sockets and dynamically assigned ports.
  // Visible windows share OS focus and must remain sequential.
  fullyParallel: background,
  workers: background ? Math.min(4, availableParallelism()) : 1,
  timeout: 60000,
  globalSetup: './tests/e2e/window-audit-setup.ts',
  globalTeardown: './tests/e2e/window-audit-teardown.ts',
  use: { trace: 'retain-on-failure' },
});
