import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';

// A real browser is necessary for ResizeObserver, masks, focus and Web Animations.
// Keep this separate from the app's audited Node/Electron test configuration.
export default defineConfig({
  test: {
    projects: (['no-preference', 'reduce'] as const).map(reducedMotion => ({
      plugins: [storybookTest({ configDir: '.storybook', storybookScript: 'pnpm storybook' })],
      test: {
        name: `catalog-${reducedMotion}`,
        browser: {
          enabled: true,
          headless: true,
          provider: playwright({ contextOptions: { reducedMotion } }),
          instances: [{ browser: 'chromium' as const }],
        },
      },
    })),
  },
});
