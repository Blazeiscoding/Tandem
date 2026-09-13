import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let launched: { app: ElectronApplication; data: string } | undefined;

test.afterEach(async ({}, info) => {
  if (!launched) return;
  const { app, data } = launched;
  launched = undefined;
  const passed = info.status === info.expectedStatus;
  if (passed) {
    await app.close();
  } else {
    // Stopped part-way, the app may still be hosting, and closing it would wait
    // on a quit confirmation nobody is there to answer, left open on the screen
    // of whoever ran the test. End it instead, and on Windows end the whole
    // tree: Playwright starts the app through cmd.exe and hands back that shell,
    // so killing only the process it returns leaves the app running.
    const pid = app.process().pid;
    if (process.platform === "win32" && pid)
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else app.process().kill("SIGKILL");
  }
  try {
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    // A cleanup error must not hide the failure that brought us here.
    if (passed) throw error;
  }
});

test("packaged Windows app boots with sandbox, hosts a workspace, serves the web client, and keeps hosting only while asked to", async ({}, info) => {
  const data = mkdtempSync(join(tmpdir(), "slackoss-desktop-"));
  // A terminal inside an Electron-based tool can pass this down, and it turns
  // the app into plain Node: launch then fails with "bad option".
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env;
  const app = await electron.launch({
    executablePath: resolve("apps/desktop/release/win-unpacked/Gatherline.exe"),
    env: {
      ...inherited,
      SLACKOSS_TEST: "1",
      SLACKOSS_TEST_MEDIA: "1",
      SLACKOSS_USER_DATA_DIR: data,
    },
  });
  launched = { app, data };

  const page = await app.firstWindow();
  expect(await app.evaluate(({ app }) => app.getName())).toBe("Gatherline");
  expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(data);
  await expect(page).toHaveTitle("Gatherline");
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await expect(page.getByText("Find your workspace", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => typeof (window as any).slackoss.hostingStart)).toBe("function");
  expect(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.getLastWebPreferences().sandbox,
    ),
  ).toBe(true);
  // A test cannot click the tray, but its menu is rebuilt on every change, so
  // each menu it is given can be read as it is given.
  await app.evaluate(({ Tray }) => {
    const menus: { label: string; enabled: boolean }[][] = [];
    (globalThis as any).trayMenus = menus;
    const setContextMenu = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function (menu) {
      if (menu)
        menus.push(
          menu.items
            .filter((item) => item.type !== "separator")
            .map((item) => ({ label: item.label, enabled: item.enabled })),
        );
      return setContextMenu.call(this, menu);
    };
  });
  const trayMenu = () => app.evaluate(() => (globalThis as any).trayMenus.at(-1));
  await page.getByRole("button", { name: "Host a workspace on this computer" }).click();
  await page.getByPlaceholder("Workspace name (e.g. Rocket Team)").fill("Desktop Test");
  await page.getByRole("button", { name: "Start hosting", exact: true }).click();
  await page.getByPlaceholder("username", { exact: true }).fill("desktopowner");
  await page.getByPlaceholder("Display name", { exact: true }).fill("Desktop Owner");
  await page.getByPlaceholder("Password (8+ characters)").fill("password123");
  await page.getByRole("button", { name: "Join workspace", exact: true }).click();
  await expect(page.locator("textarea")).toBeVisible();
  const status = await page.evaluate(() => (window as any).slackoss.hostingStatus());
  await expect.poll(trayMenu).toEqual([
    { label: "Open Gatherline", enabled: true },
    { label: `Hosting Desktop Test · port ${status.port}`, enabled: false },
    { label: "Stop hosting…", enabled: true },
    { label: "Stop hosting and quit…", enabled: true },
  ]);
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
  console.log("Desktop process memory (KiB):", metrics);

  // Manage hosting from inside the workspace being hosted.
  const manage = page.getByRole("button", { name: "Manage hosting", exact: true });
  await manage.click();
  const live = page.getByRole("dialog", { name: "Workspace is live" });
  await expect(live.getByText("Desktop Test", { exact: true })).toBeVisible();
  await expect(live.getByText(String(status.port), { exact: true })).toBeVisible();
  // Already on screen, so there is nothing to open.
  await expect(live.getByRole("button", { name: "Open it", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(live).toBeHidden();
  await expect(page.locator("textarea")).toBeVisible();

  // Closing the window while hosting keeps the app, and the workspace, running.
  // A window closes asynchronously, so give it long enough to have closed.
  const closedWhileHosting = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    return new Promise<boolean>((resolve) => {
      win.once("closed", () => resolve(true));
      setTimeout(() => resolve(false), 1_000);
      win.close();
    });
  });
  expect(closedWhileHosting).toBe(false);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect((await fetch(`http://127.0.0.1:${status.port}/api/health`)).status).toBe(200);

  // Stopping asks first, then stops the server.
  await manage.click();
  await live.getByRole("button", { name: "Stop hosting", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Stop hosting?" });
  await confirm.getByRole("button", { name: "Stop hosting", exact: true }).click();
  await expect(manage).toBeHidden();
  await expect
    .poll(() =>
      fetch(`http://127.0.0.1:${status.port}/api/health`).then(
        () => "up",
        () => "down",
      ),
    )
    .toBe("down");
  await expect.poll(trayMenu).toEqual([
    { label: "Open Gatherline", enabled: true },
    { label: "Not hosting", enabled: false },
    { label: "Stop hosting…", enabled: false },
    { label: "Quit Gatherline", enabled: true },
  ]);
  expect(errors).toEqual([]);

  // With nothing hosted, closing the last window quits.
  const closed = app.waitForEvent("close");
  await app.evaluate(({ BrowserWindow }) => {
    setTimeout(() => BrowserWindow.getAllWindows()[0]!.close(), 0);
  });
  await closed;
});
