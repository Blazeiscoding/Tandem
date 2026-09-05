import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("packaged Windows app boots with sandbox, hosts a workspace, and serves the web client", async ({}, info) => {
  const data = mkdtempSync(join(tmpdir(), "slackoss-desktop-"));
  const app = await electron.launch({
    executablePath: resolve("apps/desktop/release/win-unpacked/SlackOSS.exe"),
    env: {
      ...process.env,
      SLACKOSS_TEST: "1",
      SLACKOSS_TEST_MEDIA: "1",
      SLACKOSS_USER_DATA_DIR: data,
    },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await expect(page.getByText("Find your workspace", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => typeof (window as any).slackoss.hostingStart)).toBe(
      "function",
    );
    expect(
      await app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences().sandbox,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Host a workspace on this computer" }).click();
    await page.getByPlaceholder("Workspace name (e.g. Rocket Team)").fill("Desktop Test");
    await page.getByRole("button", { name: "Start hosting", exact: true }).click();
    await page.getByPlaceholder("username", { exact: true }).fill("desktopowner");
    await page.getByPlaceholder("Display name", { exact: true }).fill("Desktop Owner");
    await page.getByPlaceholder("Password (8+ characters)").fill("password123");
    await page.getByRole("button", { name: "Join workspace", exact: true }).click();
    await expect(page.locator("textarea")).toBeVisible();
    const status = await page.evaluate(() => (window as any).slackoss.hostingStatus());
    const web = await fetch(`http://127.0.0.1:${status.port}/`);
    expect(web.status).toBe(200);
    expect(await web.text()).toContain('<div id="root">');
    await page.getByTitle("Start a huddle", { exact: true }).click();
    await expect(page.getByText("Huddle in #general", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Leave", exact: true }).click();
    await page.screenshot({ path: info.outputPath("desktop.png") });
    const metrics = await app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => ({ type: m.type, workingSetKB: m.memory.workingSetSize })),
    );
    await info.attach("process-memory", {
      body: JSON.stringify(metrics, null, 2),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
    console.log("Desktop process memory (KiB):", metrics);
    await page.evaluate(() => (window as any).slackoss.hostingStop());
  } finally {
    await app.close();
    rmSync(data, { recursive: true, force: true });
  }
});
