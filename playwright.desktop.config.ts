import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  // What the tests launch must be built from the checkout (IMP-08).
  globalSetup: "./tests/e2e/fresh-desktop.setup.ts",
  testMatch: "desktop.spec.ts",
  workers: 1,
  timeout: 60_000,
  outputDir: "test-results/desktop",
  expect: { timeout: 15_000 },
});
