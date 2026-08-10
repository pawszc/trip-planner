import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Jednostki domenowe działają w Node i nie uruchamiają serwera ani przeglądarki.
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
