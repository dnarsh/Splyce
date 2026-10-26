import { defineConfig } from "@playwright/test";

const executablePath = process.env.SPLYCE_BROWSER_PATH;

export default defineConfig({
  testDir: "./tests/td18",
  testMatch: /.*\.e2e\.spec\.ts/,
  fullyParallel: false,
  use: {
    baseURL: "http://localhost:1421",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: "npm run dev -- --port 1421",
    url: "http://localhost:1421/tests/td18/fixture.html",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
