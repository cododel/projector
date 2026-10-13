import { defineConfig } from '@playwright/test';
delete process.env.NO_COLOR;

export default defineConfig({
  testDir: 'dev/visual',
  outputDir: '.tmp/storybook-visual-results',
  snapshotPathTemplate: '{testDir}/baselines/{arg}-{platform}{ext}',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:6006', viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce', colorScheme: 'light' },
  webServer: {
    command: 'pnpm storybook --ci',
    url: 'http://127.0.0.1:6006',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
