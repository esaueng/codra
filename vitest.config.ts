import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@server': resolve(__dirname, './apps/worker/src'),
      '@client': resolve(__dirname, './apps/dashboard/src'),
      '@': resolve(__dirname, './apps/dashboard/src'),
      'cloudflare:workers': resolve(__dirname, './test/mocks/cloudflare-workers.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts', 'test/**/*.spec.tsx'],
    passWithNoTests: true,
    setupFiles: [resolve(__dirname, './test/setup.ts')],
    // Each worker receives an isolated in-process Miniflare D1 database.
    fileParallelism: true,
    maxWorkers: 6,
  },
});
