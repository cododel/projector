import { defineConfig } from '@playwright/test';

process.env.BLUEPRINT_E2E_VISIBLE = '1';
process.env.BLUEPRINT_E2E_BACKGROUND = '0';
process.env.BLUEPRINT_CODEX_TEST = '1';

export default defineConfig({
  testDir: 'tests/e2e',
  // This guarantee requires hidden windows and is run separately by check:full.
  testIgnore: ['**/background.spec.ts', '**/stage-performance.spec.ts'],
  workers: 1,
  timeout: 60000,
  reporter: [['list'], ['./tests/e2e/no-skips-reporter.ts']],
  use: { trace: 'retain-on-failure' },
});
