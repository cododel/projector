import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ['zod'] },
      rollupOptions: { input: 'src/main/index.ts' },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts',
          'browser-overlay': 'src/preload/browser-overlay.ts',
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: { plugins: [react()], build: { rollupOptions: { input: 'src/renderer/index.html' } } },
});
