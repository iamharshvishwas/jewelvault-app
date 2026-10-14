import { defineConfig, devices } from '@playwright/test';

// End-to-end tests live in tests/e2e. Installing the packages does not download a browser:
// run `npx playwright install chromium` once on a machine that will run the tests.
//
// The dev-server port comes from PORT: scripts/lane.mjs gives every lane its own (main 4028, a 4128, b 4228, c 4328) and
// writes it to .env.local, so two lanes never meet on one port and a lane never tests another lane's code by reusing
// its server. Run the tests through the lane so the Supabase URL and key are the lane's too:
//   LANE=a npm run lane -- run npx playwright test
const PORT = Number(process.env.PORT || 4028);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  // Serial on purpose: the tests of a lane share one local database.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Playwright starts the dev server itself, and reuses one that is already running on this lane's port.
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
});
