import { defineConfig } from '@playwright/test';
delete process.env.NO_COLOR;

export default defineConfig({
  testDir: 'dev/visual',
  outputDir: '.tmp/storybook-visual-results',
  snapshotPathTemplate: '{testDir}/baselines/{arg}-{platform}{ext}',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:6007', viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce', colorScheme: 'light' },
  webServer: {
    command: 'node scripts/serve-catalog.mjs 6007',
    url: 'http://127.0.0.1:6007',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
