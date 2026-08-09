import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/trip-planner': {
        target: 'http://127.0.0.1:4004',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:4004',
        changeOrigin: true,
      },
    },
  },
});
