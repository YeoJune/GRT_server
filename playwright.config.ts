import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './web/e2e',
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node --import tsx scripts/e2e-server.ts',
    url: 'http://127.0.0.1:3100/healthz',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
