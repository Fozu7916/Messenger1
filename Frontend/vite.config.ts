import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Бэкенд разрешает CORS только для http://localhost:5173 — порт зафиксирован.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
