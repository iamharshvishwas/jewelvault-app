import { defineConfig, devices } from '@playwright/test';
import { lanePorts } from './scripts/e2e-ports.cjs';

// End-to-end tests live in tests/e2e. Installing the packages does not download a browser: run
// `npx playwright install chromium` once on a machine that will run the tests.
//
// They run against a lane: a MariaDB container, the API built from JV_API_DIR and three test users, which the global setup starts
// before the first test and stops after the last (scripts/e2e-lane.mjs, WEB00). Nothing starts unless E2E=1 says so:
//   LANE=b JV_API_DIR=../jewelvault-api E2E=1 npx playwright test tests/e2e/harness.spec.ts
//
// The site's port comes from PORT, else from the lane (main 4028, a 4128, b 4228, c 4328), else 4028; the lane's API listens on the next
// port. Playwright starts the dev server itself, with the lane's API address as the only build-time variable (H4), and never reuses a
// server that is already running on that port: a lane never tests another run's code.
const { web: PORT, webOrigin: BASE_URL, apiOrigin: API_URL } = lanePorts(process.env);

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  // Starts the lane, makes the logins of the tests and stops everything again (WEB00).
  globalSetup: './tests/e2e/global-setup.ts',
  // A first request to the dev server compiles the page, which takes several seconds.
  expect: { timeout: 15_000 },
  // Serial on purpose: the tests of a lane share one database.
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
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    env: { PORT: String(PORT), NEXT_PUBLIC_API_URL: API_URL },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
