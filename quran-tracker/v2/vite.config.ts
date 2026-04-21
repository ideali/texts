import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: '/quran/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        inference: resolve(__dirname, 'src/worker/inference.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Worker gets a stable name (no hash) so main.ts can reference it
          if (chunkInfo.name === 'inference') {
            return 'assets/inference.js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
  worker: {
    format: 'iife',
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
