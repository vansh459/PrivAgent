import { defineConfig } from "@playwright/test";

/**
 * Chromium only. Playwright cannot load extensions in Firefox, so Firefox is verified
 * separately with `web-ext run` - see docs/TESTING.md.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "retain-on-failure" },
});
