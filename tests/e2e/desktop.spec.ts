import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  await page.getByLabel("Username", { exact: true }).fill("desktopowner");
  await page.getByLabel("Display name", { exact: true }).fill("Desktop Owner");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Join workspace", exact: true }).click();
  await expect(page.locator("textarea")).toBeVisible();
  const status = await page.evaluate(() => (window as any).slackoss.hostingStatus());
  // The app grants its own notifications, so it has nothing to ask about;
  // refused, every notification it tried to show failed without a word.
  expect(await page.evaluate(() => Notification.permission)).toBe("granted");
  await expect(page.getByRole("region", { name: "Notifications" })).toHaveCount(0);
  await expect.poll(trayMenu).toEqual([
    { label: "Open Gatherline", enabled: true },
    { label: `Hosting Desktop Test · port ${status.port}`, enabled: false },
    { label: "Stop hosting…", enabled: true },
    { label: "Stop hosting and quit…", enabled: true },
  ]);
  const web = await fetch(`http://127.0.0.1:${status.port}/`);
  expect(web.status).toBe(200);
  expect(await web.text()).toContain('<div id="root">');
  await page.getByRole("button", { name: "Start a huddle", exact: true }).click();
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

  // Back it up while it runs, into a folder chosen in the system's own dialog.
  const backups = mkdtempSync(join(tmpdir(), "slackoss-desktop-backup-"));
  try {
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [folder],
      })) as unknown as typeof dialog.showOpenDialog;
    }, backups);
    await live.getByRole("button", { name: "Back up now", exact: true }).click();
    await expect(live.getByText(/^Backed up Desktop Test to /)).toBeVisible();
    const made = readdirSync(backups);
    expect(made).toEqual([expect.stringMatching(/^desktop-test-/)]);
    const manifest = JSON.parse(readFileSync(join(backups, made[0]!, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ format: 1, workspaceName: "Desktop Test" });
  } finally {
    rmSync(backups, { recursive: true, force: true });
  }
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

  // A teammate writes while the window is closed to the tray. The message
  // notifies, and clicking the notification brings the window back at it.
  // A test cannot click a system notification, so the renderer's is recorded.
  await page.evaluate(() => {
    const shown: Array<{ onclick: ((event: Event) => void) | null }> = [];
    (window as any).shownNotifications = shown;
    (window as any).Notification = class {
      static permission = "granted";
      onclick: ((event: Event) => void) | null = null;
      constructor() {
        shown.push(this);
      }
      close() {}
    };
  });
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const focus = win.focus.bind(win);
    (globalThis as any).reveals = 0;
    win.focus = () => {
      (globalThis as any).reveals++;
      focus();
    };
  });
  const hosted = `http://127.0.0.1:${status.port}`;
  const teammate = await (
    await fetch(`${hosted}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: "teammate",
        displayName: "Teammate",
        password: "password123",
      }),
    })
  ).json();
  const auth = { authorization: `Bearer ${teammate.token}`, "content-type": "application/json" };
  const { users } = await (await fetch(`${hosted}/api/users`, { headers: auth })).json();
  const owner = users.find((u: { handle: string }) => u.handle === "desktopowner");
  const dm = await (
    await fetch(`${hosted}/api/channels`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: "dm", memberIds: [owner.id] }),
    })
  ).json();
  const posted = await (
    await fetch(`${hosted}/api/channels/${dm.channel.id}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "desktop notification check" }),
    })
  ).json();
  await expect.poll(() => page.evaluate(() => (window as any).shownNotifications.length)).toBe(1);
  await page.evaluate(() => (window as any).shownNotifications[0].onclick(new Event("click")));
  await expect.poll(() => app.evaluate(() => (globalThis as any).reveals)).toBeGreaterThan(0);
  await expect(page.locator(`[data-mid="${posted.message.id}"]`)).toContainText(
    "desktop notification check",
  );

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

test("restarting offers to host the last workspace again instead of reconnecting", async () => {
  const data = mkdtempSync(join(tmpdir(), "slackoss-desktop-resume-"));
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env;
  const env = {
    ...inherited,
    SLACKOSS_TEST: "1",
    SLACKOSS_TEST_MEDIA: "1",
    SLACKOSS_USER_DATA_DIR: data,
  };
  const executablePath = resolve("apps/desktop/release/win-unpacked/Gatherline.exe");
  let app = await electron.launch({ executablePath, env });
  const killTree = () => {
    const pid = app.process().pid;
    if (process.platform === "win32" && pid)
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else app.process().kill("SIGKILL");
  };
  try {
    let page = await app.firstWindow();
    await expect(page.getByText("Find your workspace", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Host a workspace on this computer" }).click();
    await page.getByPlaceholder("Workspace name (e.g. Rocket Team)").fill("Resume Test");
    await page.getByRole("button", { name: "Start hosting", exact: true }).click();
    await page.getByLabel("Username", { exact: true }).fill("resumeowner");
    await page.getByLabel("Display name", { exact: true }).fill("Resume Owner");
    await page.getByLabel("Password", { exact: true }).fill("password123");
    await page.getByRole("button", { name: "Join workspace", exact: true }).click();
    await expect(page.locator("textarea")).toBeVisible();

    // Stop hosting, then quit with nothing hosted: a plain window close quits.
    await page.getByRole("button", { name: "Manage hosting", exact: true }).click();
    const live = page.getByRole("dialog", { name: "Workspace is live" });
    await live.getByRole("button", { name: "Stop hosting", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Stop hosting?" })
      .getByRole("button", { name: "Stop hosting", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Manage hosting", exact: true })).toBeHidden();
    const firstQuit = app.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => {
      setTimeout(() => BrowserWindow.getAllWindows()[0]!.close(), 0);
    });
    await firstQuit;

    // Relaunch with the same profile: no reconnecting to a stopped server.
    app = await electron.launch({ executablePath, env });
    page = await app.firstWindow();
    await expect(page.getByText("Find your workspace", { exact: true })).toBeVisible();
    const resume = page.getByRole("region", { name: "Hosted on this computer" });
    await expect(resume).toBeVisible();
    await resume.getByRole("button", { name: "Start hosting Resume Test" }).click();
    // The saved sign-in still works, so the workspace opens with no password asked.
    await expect(page.locator("textarea")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    const resumed = await page.evaluate(() => (window as any).slackoss.hostingStatus());
    expect(resumed).toMatchObject({ running: true });

    // A name that differs only by punctuation is a separate workspace. Earlier
    // versions put both in one folder and renamed the first.
    const named = async (port: number) =>
      (await (await fetch(`http://127.0.0.1:${port}/api/server-info`)).json()).workspaceName;
    const other = await page.evaluate(async () => {
      const bridge = (window as any).slackoss;
      await bridge.hostingStop();
      return bridge.hostingStart({ workspaceName: "Resume-Test" });
    });
    expect(other.folder).not.toBe(resumed.folder);
    expect(await named(other.port)).toBe("Resume-Test");

    // Back the new one up while it runs, through the system's folder dialog.
    const backups = mkdtempSync(join(tmpdir(), "slackoss-desktop-restore-"));
    const pick = (folder: string) =>
      app.evaluate(({ dialog }, chosen) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [chosen],
        })) as unknown as typeof dialog.showOpenDialog;
      }, folder);
    await pick(backups);
    const backedUp = await page.evaluate(
      (folder) => (window as any).slackoss.hostingBackup(folder),
      other.folder,
    );
    expect(backedUp.path).toContain("resume-test-");
    const listed = await page.evaluate(async () => {
      const bridge = (window as any).slackoss;
      await bridge.hostingStop();
      return bridge.hostingList();
    });
    expect(listed.workspaces.map((w: { name: string }) => w.name)).toEqual([
      "Resume-Test",
      "Resume Test",
    ]);
    const back = await page.evaluate(
      (folder) => (window as any).slackoss.hostingStart({ folder }),
      resumed.folder,
    );
    expect(back.port).toBe(resumed.port);
    expect(await named(back.port)).toBe("Resume Test");

    // Its folder lost, Resume-Test comes back from the backup into the same
    // place in the list, without starting.
    rmSync(join(data, "hosted", other.folder), { recursive: true, force: true });
    await pick(backedUp.path);
    expect(await page.evaluate(() => (window as any).slackoss.hostingRestore())).toEqual({
      folder: other.folder,
      name: "Resume-Test",
    });
    const afterRestore = await page.evaluate(() => (window as any).slackoss.hostingList());
    expect(
      afterRestore.workspaces.find((w: { folder: string }) => w.folder === other.folder),
    ).toMatchObject({ missing: false, running: false });
    rmSync(backups, { recursive: true, force: true });
    await expect(page.locator("textarea")).toBeVisible();

    // Renamed while stopped, the new name goes into its database and its
    // folder stays where it is.
    expect(
      await page.evaluate(
        (folder) => (window as any).slackoss.hostingRename(folder, " Resume Renamed "),
        other.folder,
      ),
    ).toEqual({ folder: other.folder, name: "Resume Renamed" });
    const afterRename = await page.evaluate(() => (window as any).slackoss.hostingList());
    expect(
      afterRename.workspaces.find((w: { folder: string }) => w.folder === other.folder),
    ).toMatchObject({ name: "Resume Renamed", missing: false });
    // Open folder shows the folder the list names, whatever the window asks.
    await app.evaluate(({ shell }) => {
      (globalThis as any).opened = [];
      shell.openPath = (async (path: string) => {
        (globalThis as any).opened.push(path);
        return "";
      }) as typeof shell.openPath;
    });
    await page.evaluate(
      (folder) => (window as any).slackoss.hostingOpenFolder(folder),
      other.folder,
    );
    await expect(
      page.evaluate(() => (window as any).slackoss.hostingOpenFolder("../..")),
    ).rejects.toThrow(/not in the list/);
    expect(await app.evaluate(() => (globalThis as any).opened)).toEqual([
      join(data, "hosted", other.folder),
    ]);

    // Renamed while it runs, from the host dialog: the open client and the
    // server both take the new name at once.
    await page.getByRole("button", { name: "Manage hosting", exact: true }).click();
    const renaming = page.getByRole("dialog", { name: "Workspace is live" });
    await renaming.getByRole("button", { name: "Rename Resume Test" }).click();
    const newName = renaming.getByRole("textbox", { name: "New name for Resume Test" });
    await newName.fill("Resume Live");
    await newName.press("Enter");
    await expect(renaming.getByText("Renamed Resume Test to Resume Live.")).toBeVisible();
    expect(await named(back.port)).toBe("Resume Live");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Resume Live");

    // Leave nothing hosted behind: stop, then a plain close quits.
    await page.getByRole("button", { name: "Manage hosting", exact: true }).click();
    const liveAgain = page.getByRole("dialog", { name: "Workspace is live" });
    await liveAgain.getByRole("button", { name: "Stop hosting", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Stop hosting?" })
      .getByRole("button", { name: "Stop hosting", exact: true })
      .click();
    const secondQuit = app.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) => {
      setTimeout(() => BrowserWindow.getAllWindows()[0]!.close(), 0);
    });
    await secondQuit;
  } finally {
    try {
      killTree();
    } catch {
      // Already quit: the directory removes below regardless.
    }
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
