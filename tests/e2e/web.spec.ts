import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ChildProcess;
let data: string;
const base = "http://127.0.0.1:18543";
test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), "slackoss-e2e-"));
  server = spawn(process.execPath, ["apps/server-cli/dist/slackoss-server.js", "--data", data, "--port", "18543", "--host", "127.0.0.1", "--no-mdns", "--name", "Product Test"], { windowsHide: true, stdio: "pipe" });
  await expect.poll(async () => { try { return (await fetch(base + "/api/health")).status; } catch { return 0; } }).toBe(200);
});
test.afterAll(async () => {
  if (server && server.exitCode === null) { const exited = new Promise((r) => server.once("exit", r)); server.kill(); await exited; }
  if (data) rmSync(data, { recursive: true, force: true });
});

async function register(page: Page, handle: string) {
  await page.goto(base);
  await page.getByPlaceholder("192.168.1.42:8543 or chat.yourteam.dev").fill(base);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByPlaceholder("username", { exact: true })).toBeVisible();
  const create = page.getByRole("button", { name: "Create account", exact: true });
  if (await create.isVisible()) await create.click();
  await page.getByPlaceholder("username", { exact: true }).fill(handle);
  await page.getByPlaceholder("Display name", { exact: true }).fill(handle);
  await page.getByPlaceholder("Password (8+ characters)").fill("password123");
  await page.getByRole("button", { name: "Join workspace", exact: true }).click();
  await expect(page.locator("textarea")).toBeVisible();
}

test("two people register, chat, become friends, reconnect, and exchange real WebRTC media", async ({ browser }, info) => {
  const a = await browser.newContext({ permissions: ["microphone", "camera"], viewport: { width: 1280, height: 820 } });
  const b = await browser.newContext({ permissions: ["microphone", "camera"], viewport: { width: 1280, height: 820 } });
  const alice = await a.newPage(); const bob = await b.newPage();
  const errors: string[] = [];
  for (const page of [alice, bob]) {
    page.on("pageerror", (err) => errors.push(err.message));
    await page.addInitScript(() => {
      const Original = window.RTCPeerConnection;
      (window as any).peers = [];
      window.RTCPeerConnection = class extends Original {
        constructor(config?: RTCConfiguration) { super(config); (window as any).peers.push(this); }
      };
    });
  }
  try {
    await register(alice, "alice");
    await register(bob, "bobby");
    await alice.locator("textarea").fill("Hello from Alice — live delivery");
    await alice.locator("textarea").press("Enter");
    await expect(bob.getByText("Hello from Alice — live delivery", { exact: true })).toBeVisible();
    await alice.getByRole("button", { name: "Friends", exact: true }).click();
    await alice.getByRole("button", { name: "Add friends", exact: true }).click();
    await alice.getByRole("button", { name: "Add friend", exact: true }).click();
    await bob.getByRole("button", { name: "Friends 1" }).click();
    await bob.getByRole("button", { name: "Requests (1)", exact: true }).click();
    await bob.getByRole("button", { name: "Accept", exact: true }).click();
    await alice.getByRole("button", { name: "Friends", exact: true }).last().click();
    await expect(alice.getByRole("button", { name: "Remove friend" })).toBeVisible();
    await alice.keyboard.press("Escape"); await bob.keyboard.press("Escape");
    await b.setOffline(true);
    await alice.locator("textarea").fill("Message while Bob is offline"); await alice.locator("textarea").press("Enter");
    await b.setOffline(false);
    await expect(bob.getByText("Message while Bob is offline", { exact: true })).toBeVisible();
    await alice.getByTitle("Start a huddle", { exact: true }).click();
    await expect(alice.getByText("Huddle in #general", { exact: true })).toBeVisible();
    await bob.getByTitle("Join the huddle (1)", { exact: true }).click();
    for (const page of [alice, bob]) {
      await expect.poll(() => page.evaluate(() => (window as any).peers.some((p: RTCPeerConnection) => p.connectionState === "connected"))).toBe(true);
      await expect.poll(() => page.evaluate(async () => {
        let bytes = 0;
        for (const pc of (window as any).peers as RTCPeerConnection[]) (await pc.getStats()).forEach((r) => { if (r.type === "inbound-rtp" && r.kind === "audio") bytes += r.bytesReceived; });
        return bytes;
      })).toBeGreaterThan(0);
    }
    await alice.getByTitle("Turn your camera on", { exact: true }).click();
    await expect.poll(() => bob.locator("video").evaluateAll((videos) => videos.some((v) => (v as HTMLVideoElement).videoWidth > 0))).toBe(true);
    await alice.getByTitle("Mute", { exact: true }).click();
    await expect(alice.getByTitle("Unmute", { exact: true })).toBeVisible();
    await alice.screenshot({ path: info.outputPath("workspace.png") });
    await alice.getByRole("button", { name: "Leave", exact: true }).click();
    await bob.getByRole("button", { name: "Leave", exact: true }).click();
    await expect.poll(() => alice.evaluate(() => (window as any).peers.every((p: RTCPeerConnection) => p.connectionState === "closed"))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    for (const [name, page] of [["alice", alice], ["bob", bob]] as const) {
      const diagnostics = await page.evaluate(async () => Promise.all(((window as any).peers ?? []).map(async (pc: RTCPeerConnection) => ({
        connection: pc.connectionState,
        senders: pc.getSenders().map((s) => ({ kind: s.track?.kind, enabled: s.track?.enabled, state: s.track?.readyState })),
        stats: [...(await pc.getStats()).values()].filter((r) => ["inbound-rtp", "outbound-rtp", "media-source"].includes(r.type)),
      })))).catch(() => null);
      await info.attach(`${name}-rtc`, { body: JSON.stringify(diagnostics, null, 2), contentType: "application/json" });
    }
    await a.close().catch(() => {}); await b.close().catch(() => {});
  }
});

test("scrolls back through a long channel without unbounded growth or losing its place", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  try {
    await register(page, "carol");
    // Far more history than the client keeps in memory, posted as the same user.
    const token = await page.evaluate(
      () => (JSON.parse(localStorage.getItem("slackoss:servers") ?? "[]") as { token: string }[])[0]!.token,
    );
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const channels = await (await fetch(`${base}/api/channels`, { headers: auth })).json();
    const general = channels.channels.find((c: { name: string }) => c.name === "general");
    for (let i = 0; i < 500; i++) {
      await fetch(`${base}/api/channels/${general.id}/messages`, {
        method: "POST", headers: auth, body: JSON.stringify({ text: `history ${i}` }),
      });
    }
    await page.reload();
    // The timeline scroller, not the sidebar's: the one holding message rows.
    const scroller = page.locator("div.overflow-y-auto").filter({ has: page.locator("[data-mid]") }).first();
    await expect(page.getByText("history 499", { exact: true })).toBeVisible();

    // Scroll to the top repeatedly; each pass pages in another 50 messages.
    // Six passes overfill the 300-message window while leaving history behind.
    for (let pass = 0; pass < 6; pass++) {
      await scroller.evaluate((el) => { el.scrollTop = 0; });
      await page.waitForTimeout(250);
    }
    const rows = await page.locator("[data-mid]").count();
    expect(rows).toBeGreaterThan(100);
    // The window is capped at 300 messages, so the DOM cannot grow past it.
    expect(rows).toBeLessThanOrEqual(300);

    // The message under the reader stays under the reader across a page load.
    // Park just inside the paging threshold and read the anchor synchronously,
    // before the fetch it triggers can come back.
    const before = await scroller.evaluate((el) => {
      el.scrollTop = 350;
      const rows = [...el.querySelectorAll<HTMLElement>("[data-mid]")];
      const row = rows.find((r) => r.offsetTop + r.offsetHeight > el.scrollTop)!;
      return { id: row.dataset.mid!, top: row.getBoundingClientRect().top, firstId: rows[0]!.dataset.mid! };
    });
    // At the cap a page swaps messages in and out without changing the count,
    // so wait on the oldest loaded message changing instead.
    await expect
      .poll(() => scroller.evaluate((el) => el.querySelector<HTMLElement>("[data-mid]")!.dataset.mid))
      .not.toBe(before.firstId);
    await page.waitForTimeout(200);
    const after = await page
      .locator(`[data-mid="${before.id}"]`)
      .evaluate((el) => el.getBoundingClientRect().top);
    // Older messages arrived above it and trimmed ones left below it; it holds still.
    expect(Math.abs(after - before.top)).toBeLessThan(8);
    expect(errors).toEqual([]);
  } finally {
    await context.close().catch(() => {});
  }
});
