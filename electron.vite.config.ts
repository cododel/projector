import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  main: {
    // Keep ws self-contained. Optional native acceleration cannot be replaced by
    // Rollup's empty optional-dependency shim in a relocated Electron package.
    define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"', 'process.env.WS_NO_UTF_8_VALIDATE': '"1"' },
    build: {
      externalizeDeps: { exclude: ['zod', 'ws'] },
      rollupOptions: { input: 'src/main/index.ts' },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts',
          'browser-overlay': 'src/preload/browser-overlay.ts',
          notifications: 'src/preload/notifications.ts',
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: { plugins: [react()], build: { rollupOptions: { input: { index: 'src/renderer/index.html', notifications: 'src/renderer/notifications.html' } } } },
});
