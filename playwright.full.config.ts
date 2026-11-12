import { defineConfig } from '@playwright/test';
import config from './playwright.config';

process.env.PROJECTOR_CODEX_TEST = '1';

export default defineConfig({
  ...config,
  reporter: [['list'], ['./tests/e2e/no-skips-reporter.ts']],
});
