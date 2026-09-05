import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "desktop.spec.ts",
  workers: 1,
  timeout: 60_000,
  outputDir: "test-results/desktop",
  expect: { timeout: 15_000 },
});
