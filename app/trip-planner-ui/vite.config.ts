import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Plugin kompiluje JSX i zapewnia szybkie odświeżanie komponentów React.
  plugins: [react()],
  server: {
    proxy: {
      // Żądania aplikacyjne trafiają do lokalnego CAP; przeglądarka widzi jeden origin.
      '/trip-planner': {
        target: 'http://127.0.0.1:4004',
        changeOrigin: true,
      },
      // Proxy health ułatwia lokalne sprawdzanie gotowości backendu.
      '/health': {
        target: 'http://127.0.0.1:4004',
        changeOrigin: true,
      },
    },
  },
});
