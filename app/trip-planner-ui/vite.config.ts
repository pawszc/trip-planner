import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Plugin kompiluje JSX i zapewnia szybkie odświeżanie komponentów React.
  plugins: [react()],
  server: {
    // Stały port i bind sieciowy umożliwiają dostęp przez wystawiony endpoint Tailscale.
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    allowedHosts: ['dxx.tail5198b2.ts.net'],
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
