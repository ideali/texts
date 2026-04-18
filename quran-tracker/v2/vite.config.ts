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
        // Worker gets its own chunk with a stable name pattern
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'inference') {
            return 'assets/[name]-[hash].js';
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
