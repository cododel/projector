import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';

// A real browser is necessary for ResizeObserver, masks, focus and Web Animations.
// Keep this separate from the app's audited Node/Electron test configuration.
export default defineConfig({
  // Catalogue overview imports CSF metadata and composed document screens use
  // React portals. Prebundle these before tests, rather than reloading mid-run.
  optimizeDeps: { include: ['storybook/internal/csf', 'react-dom'] },
  define: { 'import.meta.env.VITE_CATALOG_FRAME_ORIGIN': JSON.stringify('http://127.0.0.1:6007') },
  test: {
    // Sheets own multiple nested production previews; bound their simultaneous
    // startup rather than letting every CPU start another collection of frames.
    maxWorkers: 2,
    projects: (['no-preference', 'reduce'] as const).map(reducedMotion => ({
      plugins: [storybookTest({ configDir: '.storybook', storybookScript: 'pnpm storybook' })],
      test: {
        name: `catalog-${reducedMotion}`,
        testTimeout: 30000,
        browser: {
          enabled: true,
          headless: true,
          provider: playwright({ contextOptions: { reducedMotion } }),
          instances: [{ name: `catalog-${reducedMotion}-chromium`, browser: 'chromium' as const }],
        },
      },
    })),
  },
});
