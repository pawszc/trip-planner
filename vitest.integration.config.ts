import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integracje uruchamiają CAP ze współdzieloną bazą in-memory, dlatego nie biegną równolegle.
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
