import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// В разработке /api и /hubs проксируются на бэкенд — CORS не нужен.
export default defineConfig({
  plugins: [react()],
  test: {
    // Юнит-тесты идут в node; тесты, которым нужен DOM, включают jsdom строкой «// @vitest-environment jsdom» в начале файла.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 15_000,
    coverage: { provider: 'v8', include: ['src/**/*.{ts,tsx}'], exclude: ['src/**/*.test.*', 'src/test/**', 'src/main.tsx'], reporter: ['text', 'html'] },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:5080', changeOrigin: true },
      '/hubs': { target: 'http://localhost:5080', changeOrigin: true, ws: true },
    },
  },
});
