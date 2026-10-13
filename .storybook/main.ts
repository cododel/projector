import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../dev/stories/**/*.stories.tsx'],
  framework: '@storybook/react-vite',
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y', '@storybook/addon-vitest'],
  core: { disableTelemetry: true },
  // Electron's build config is deliberately not loaded into the browser catalog.
  viteFinal: config => ({ ...config, server: { ...config.server, host: '127.0.0.1' } }),
};
export default config;
