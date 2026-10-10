import { defineConfig } from '@playwright/test';

// Direct `playwright test` and opt-in Codex tests use the same safe default.
process.env.BLUEPRINT_E2E_BACKGROUND = process.env.BLUEPRINT_E2E_VISIBLE === '1' ? '0' : '1';

export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  timeout: 60000,
  globalSetup: './tests/e2e/window-audit-setup.ts',
  globalTeardown: './tests/e2e/window-audit-teardown.ts',
  use: { trace: 'retain-on-failure' },
});
