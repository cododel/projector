import { defineConfig } from '@playwright/test';
import { availableParallelism } from 'node:os';

// Direct `playwright test` and opt-in Codex tests use the same safe default.
process.env.BLUEPRINT_E2E_BACKGROUND = process.env.BLUEPRINT_E2E_VISIBLE === '1' ? '0' : '1';
const background = process.env.BLUEPRINT_E2E_BACKGROUND === '1';

export default defineConfig({
  testDir: 'tests/e2e',
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
