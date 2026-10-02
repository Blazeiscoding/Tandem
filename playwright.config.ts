import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // What the tests launch must be built from the checkout (IMP-08).
  globalSetup: "./tests/e2e/fresh-web.setup.ts",
  outputDir: "test-results/web",
  testMatch: "web.spec.ts",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    actionTimeout: 12_000,
    headless: true,
    viewport: { width: 1280, height: 820 },
    permissions: ["microphone", "camera"],
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
