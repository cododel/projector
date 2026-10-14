import type { StorybookConfig } from '@storybook/react-vite';
import { readFile } from 'node:fs/promises';
import { catalogFingerprint } from '../dev/catalog-source.ts';

const config: StorybookConfig = {
  stories: ['../dev/stories/**/*.stories.tsx'],
  framework: '@storybook/react-vite',
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y', '@storybook/addon-vitest'],
  core: { disableTelemetry: true },
  // Electron's build config is deliberately not loaded into the browser catalog.
  viteFinal: config => ({ ...config, server: { ...config.server, host: '127.0.0.1' }, plugins: [...(config.plugins ?? []), {
    name: 'catalog-local-evidence',
    configureServer(server) {
      server.middlewares.use('/catalog-check.log', (_request, response) => {
        response.setHeader('Content-Type','text/plain; charset=utf-8');
        response.setHeader('Cache-Control','no-store');
        void readFile('.tmp/catalog/check.log').then(log => response.end(log)).catch(() => { response.statusCode = 404; response.end('No current check log'); });
      });
      server.middlewares.use('/catalog-evidence.json', (_request, response) => {
        void (async () => {
          const current = await catalogFingerprint(process.cwd());
          let report: Record<string, unknown> = {};
          try { report = JSON.parse(await readFile('.tmp/catalog/evidence.json', 'utf8')); } catch { /* No report is an explicit unverified state. */ }
          response.setHeader('Content-Type','application/json');
          response.setHeader('Cache-Control','no-store');
          response.end(JSON.stringify({ ...report, sourceCurrent: report.fingerprint === current }));
        })().catch(error => { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); });
      });
    },
  }] }),
};
export default config;
