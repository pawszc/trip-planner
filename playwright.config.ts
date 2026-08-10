import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // Test E2E jest sekwencyjny, ponieważ opisuje jeden pełny przepływ użytkownika.
  testDir: './test/e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // Materiały diagnostyczne są zachowywane przy błędzie, ale nie zaśmiecają udanych przebiegów.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Playwright sam uruchamia backend i frontend, więc test nie wymaga ręcznej interakcji.
  webServer: [
    {
      command: 'npm run dev:backend:e2e',
      url: 'http://127.0.0.1:4004/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'npm run dev:frontend:e2e',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
