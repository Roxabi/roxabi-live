import { defineConfig } from "@playwright/test";

const PORT = 8787;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `cd worker && npx wrangler d1 migrations apply DB --local --config ../wrangler.toml && npx wrangler dev --config ../wrangler.toml --port ${PORT} --var E2E_TEST_MODE:1`,
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});