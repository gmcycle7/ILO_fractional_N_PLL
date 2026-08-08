/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative base so the hash-routed site works both locally and under
  // a GitHub Pages subpath (https://<user>.github.io/ILO_fractional_N_PLL/).
  base: './',
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/echarts') || id.includes('node_modules/zrender')) {
            return 'echarts';
          }
          if (id.includes('node_modules/katex')) return 'katex';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
