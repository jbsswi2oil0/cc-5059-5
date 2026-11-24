import { defineConfig, devices } from '@playwright/test';

// UI smoke coverage runs against the real Vite dev server so playback, canvas
// rendering and downloads are exercised in a browser, not a stub.
export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.js/,
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      // Containers often run unprivileged; the user namespace sandbox is unavailable.
      launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
    },
  }],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
