import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(process.cwd(), 'popup.html'),
        options: resolve(process.cwd(), 'options.html'),
        offscreen: resolve(process.cwd(), 'offscreen.html'),
      },
    },
  },
});
