import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// В разработке /api и /hubs проксируются на бэкенд — CORS не нужен.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:5080', changeOrigin: true },
      '/hubs': { target: 'http://localhost:5080', changeOrigin: true, ws: true },
    },
  },
});
