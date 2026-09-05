import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ChildProcess;
let data: string;
const base = "http://127.0.0.1:18543";
test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), "slackoss-e2e-"));
  server = spawn(
    process.execPath,
    [
      "apps/server-cli/dist/slackoss-server.js",
      "--data",
      data,
      "--port",
      "18543",
      "--host",
      "127.0.0.1",
      "--no-mdns",
      "--name",
      "Product Test",
      "--allow-private-hooks",
    ],
    { windowsHide: true, stdio: "pipe" },
  );
  await expect
    .poll(async () => {
      try {
        return (await fetch(base + "/api/health")).status;
      } catch {
        return 0;
      }
    })
    .toBe(200);
});
test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill();
    await exited;
  }
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

test("two people register, chat, become friends, reconnect, and exchange real WebRTC media", async ({
  browser,
}, info) => {
  const a = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport: { width: 1280, height: 820 },
  });
  const b = await browser.newContext({
    permissions: ["microphone", "camera"],
    viewport: { width: 1280, height: 820 },
  });
  const alice = await a.newPage();
  const bob = await b.newPage();
  const errors: string[] = [];
  for (const page of [alice, bob]) {
    page.on("pageerror", (err) => errors.push(err.message));
    await page.addInitScript(() => {
      const Original = window.RTCPeerConnection;
      (window as any).peers = [];
      window.RTCPeerConnection = class extends Original {
        constructor(config?: RTCConfiguration) {
          super(config);
          (window as any).peers.push(this);
        }
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
    await alice.keyboard.press("Escape");
    await bob.keyboard.press("Escape");
    await b.setOffline(true);
    await alice.locator("textarea").fill("Message while Bob is offline");
    await alice.locator("textarea").press("Enter");
    await b.setOffline(false);
    await expect(bob.getByText("Message while Bob is offline", { exact: true })).toBeVisible();
    await alice.getByTitle("Start a huddle", { exact: true }).click();
    await expect(alice.getByText("Huddle in #general", { exact: true })).toBeVisible();
    await bob.getByTitle("Join the huddle (1)", { exact: true }).click();
    for (const page of [alice, bob]) {
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window as any).peers.some((p: RTCPeerConnection) => p.connectionState === "connected"),
          ),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            let bytes = 0;
            for (const pc of (window as any).peers as RTCPeerConnection[])
              (await pc.getStats()).forEach((r) => {
                if (r.type === "inbound-rtp" && r.kind === "audio") bytes += r.bytesReceived;
              });
            return bytes;
          }),
        )
        .toBeGreaterThan(0);
    }
    // The fake capture device plays a tone, so the level meter has something
    // real to report: each side should see the other light up as talking.
    for (const page of [alice, bob]) {
      await expect
        .poll(() => page.locator(".ring-online").count(), { timeout: 15_000 })
        .toBeGreaterThan(0);
    }
    await alice.getByTitle("Turn your camera on", { exact: true }).click();
    await expect
      .poll(() =>
        bob
          .locator("video")
          .evaluateAll((videos) => videos.some((v) => (v as HTMLVideoElement).videoWidth > 0)),
      )
      .toBe(true);
    await alice.getByTitle("Mute", { exact: true }).click();
    await expect(alice.getByTitle("Unmute", { exact: true })).toBeVisible();
    // Muting is signalled, not guessed: Bob's copy of Alice says so.
    await expect(bob.getByTitle("alice (muted)")).toBeVisible();
    await alice.screenshot({ path: info.outputPath("workspace.png") });
    await alice.getByRole("button", { name: "Leave", exact: true }).click();
    await bob.getByRole("button", { name: "Leave", exact: true }).click();
    await expect
      .poll(() =>
        alice.evaluate(() =>
          (window as any).peers.every((p: RTCPeerConnection) => p.connectionState === "closed"),
        ),
      )
      .toBe(true);
    expect(errors).toEqual([]);
  } finally {
    for (const [name, page] of [
      ["alice", alice],
      ["bob", bob],
    ] as const) {
      const diagnostics = await page
        .evaluate(async () =>
          Promise.all(
            ((window as any).peers ?? []).map(async (pc: RTCPeerConnection) => ({
              connection: pc.connectionState,
              senders: pc.getSenders().map((s) => ({
                kind: s.track?.kind,
                enabled: s.track?.enabled,
                state: s.track?.readyState,
              })),
              stats: [...(await pc.getStats()).values()].filter((r) =>
                ["inbound-rtp", "outbound-rtp", "media-source"].includes(r.type),
              ),
            })),
          ),
        )
        .catch(() => null);
      await info.attach(`${name}-rtc`, {
        body: JSON.stringify(diagnostics, null, 2),
        contentType: "application/json",
      });
    }
    await a.close().catch(() => {});
    await b.close().catch(() => {});
  }
});

test("scrolls back through a long channel without unbounded growth or losing its place", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  try {
    await register(page, "carol");
    // Far more history than the client keeps in memory, posted as the same user.
    const token = await page.evaluate(
      () =>
        (JSON.parse(localStorage.getItem("slackoss:servers") ?? "[]") as { token: string }[])[0]!
          .token,
    );
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const channels = await (await fetch(`${base}/api/channels`, { headers: auth })).json();
    const general = channels.channels.find((c: { name: string }) => c.name === "general");
    for (let i = 0; i < 500; i++) {
      await fetch(`${base}/api/channels/${general.id}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text: `history ${i}` }),
      });
    }
    await page.reload();
    // The timeline scroller, not the sidebar's: the one holding message rows.
    const scroller = page
      .locator("div.overflow-y-auto")
      .filter({ has: page.locator("[data-mid]") })
      .first();
    await expect(page.getByText("history 499", { exact: true })).toBeVisible();

    // Scroll to the top repeatedly; each pass pages in another 50 messages.
    // Six passes overfill the 300-message window while leaving history behind.
    for (let pass = 0; pass < 6; pass++) {
      await scroller.evaluate((el) => {
        el.scrollTop = 0;
      });
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
      return {
        id: row.dataset.mid!,
        top: row.getBoundingClientRect().top,
        firstId: rows[0]!.dataset.mid!,
      };
    });
    // At the cap a page swaps messages in and out without changing the count,
    // so wait on the oldest loaded message changing instead.
    await expect
      .poll(() =>
        scroller.evaluate((el) => el.querySelector<HTMLElement>("[data-mid]")!.dataset.mid),
      )
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

test("an app's button calls it back and rewrites the message it sits on", async ({
  browser,
}, info) => {
  // Stands in for the third-party app the button points at.
  let answer: (body: string) => string = () => "";
  const received: string[] = [];
  const stub: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(answer(body));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}/interactions`;

  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  try {
    // Alice owns this workspace, so she is the one who can create an app.
    const login = await (
      await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "alice", password: "password123" }),
      })
    ).json();
    const admin = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };
    const created = await (
      await fetch(`${base}/api/apps`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ name: "Deploy Bot" }),
      })
    ).json();

    // The URL has to echo the verification challenge before it is accepted.
    answer = (body) => JSON.stringify({ challenge: JSON.parse(body).challenge });
    const set = await fetch(`${base}/api/apps/${created.app.id}/interactivity`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ url: stubUrl }),
    });
    expect(set.status).toBe(200);

    await register(page, "dave");
    const channels = await (await fetch(`${base}/api/channels`, { headers: admin })).json();
    const general = channels.channels.find((c: { name: string }) => c.name === "general");

    await fetch(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        channel: general.id,
        text: "Deploy 412 to production?",
        blocks: [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "approve",
                style: "primary",
                value: "412",
                text: { type: "plain_text", text: "Approve" },
              },
            ],
          },
        ],
      }),
    });

    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toBeVisible();

    await page.screenshot({ path: info.outputPath("buttons.png") });

    received.length = 0;
    answer = () => JSON.stringify({ replace_original: true, text: "Approved. Shipping 412." });
    await approve.click();

    // The app was called with the click, and its reply replaced the message.
    await expect(page.getByText("Approved. Shipping 412.", { exact: true })).toBeVisible();
    await expect(approve).toHaveCount(0);
    const payload = JSON.parse(new URLSearchParams(received[0]!).get("payload")!);
    expect(payload.type).toBe("block_actions");
    expect(payload.actions[0].value).toBe("412");
    expect(errors).toEqual([]);
  } finally {
    await context.close().catch(() => {});
    await new Promise<void>((r) => stub.close(() => r()));
  }
});

test("a button opens the app's form, and what you type reaches the app", async ({
  browser,
}, info) => {
  // The app: verifies its URL, opens a modal when its button is pressed, and
  // records the submission.
  let botToken = "";
  const submissions: string[] = [];
  let refuseOnce = true;
  const stub: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw.startsWith("{")) {
          // The url_verification handshake.
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ challenge: JSON.parse(raw).challenge }));
        }
        const payload = JSON.parse(new URLSearchParams(raw).get("payload")!);
        if (payload.type === "block_actions") {
          await fetch(`${base}/api/views.open`, {
            method: "POST",
            headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
            body: JSON.stringify({
              trigger_id: payload.trigger_id,
              view: {
                type: "modal",
                callback_id: "deploy_form",
                title: { type: "plain_text", text: "Deploy" },
                submit: { type: "plain_text", text: "Ship it" },
                blocks: [
                  { type: "section", text: { type: "mrkdwn", text: "Where is this going?" } },
                  {
                    type: "input",
                    block_id: "where",
                    label: { type: "plain_text", text: "Environment" },
                    element: {
                      type: "static_select",
                      action_id: "env",
                      options: [
                        { text: { type: "plain_text", text: "Staging" }, value: "staging" },
                        { text: { type: "plain_text", text: "Production" }, value: "production" },
                      ],
                    },
                  },
                  {
                    type: "input",
                    block_id: "why",
                    label: { type: "plain_text", text: "Reason" },
                    element: { type: "plain_text_input", action_id: "notes" },
                  },
                ],
              },
            }),
          });
          res.writeHead(200, { "content-type": "application/json" });
          return res.end("");
        }
        submissions.push(raw);
        res.writeHead(200, { "content-type": "application/json" });
        // Refuse the first answer, the way an app that validates would.
        if (refuseOnce) {
          refuseOnce = false;
          return res.end(
            JSON.stringify({
              response_action: "errors",
              errors: { where: "Not to production on a Friday." },
            }),
          );
        }
        res.end("");
      })();
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}/interactions`;

  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  try {
    const login = await (
      await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "alice", password: "password123" }),
      })
    ).json();
    const admin = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };
    const created = await (
      await fetch(`${base}/api/apps`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({ name: "Form Bot" }),
      })
    ).json();
    botToken = created.token;
    await fetch(`${base}/api/apps/${created.app.id}/interactivity`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ url: stubUrl }),
    });

    await register(page, "erin");
    const channels = await (await fetch(`${base}/api/channels`, { headers: admin })).json();
    const general = channels.channels.find((c: { name: string }) => c.name === "general");
    await fetch(`${base}/api/chat.postMessage`, {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        channel: general.id,
        text: "Ready to deploy",
        blocks: [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "open",
                style: "primary",
                text: { type: "plain_text", text: "Deploy…" },
              },
            ],
          },
        ],
      }),
    });

    // Pressing the button opens the app's form.
    await page.getByRole("button", { name: "Deploy…", exact: true }).click();
    const modal = page.getByRole("dialog", { name: "Deploy" });
    await expect(modal).toBeVisible();
    await expect(modal.getByText("Where is this going?")).toBeVisible();

    await modal.getByLabel("Environment").selectOption("production");
    await modal.getByLabel("Reason").fill("hotfix for the login bug");
    await page.screenshot({ path: info.outputPath("modal.png") });
    await modal.getByRole("button", { name: "Ship it", exact: true }).click();

    // The app refused it, so the form stays open with its reason attached.
    await expect(modal.getByText("Not to production on a Friday.")).toBeVisible();
    await expect(modal).toBeVisible();

    // Answering again is accepted, and the form closes.
    await modal.getByLabel("Environment").selectOption("staging");
    await modal.getByRole("button", { name: "Ship it", exact: true }).click();
    await expect(modal).toHaveCount(0);

    expect(submissions).toHaveLength(2);
    const last = JSON.parse(new URLSearchParams(submissions[1]!).get("payload")!);
    expect(last.type).toBe("view_submission");
    expect(last.view.callback_id).toBe("deploy_form");
    expect(last.view.state.values.where.env.selected_option.value).toBe("staging");
    expect(last.view.state.values.why.notes.value).toBe("hotfix for the login bug");
    expect(errors).toEqual([]);
  } finally {
    await context.close().catch(() => {});
    await new Promise<void>((r) => stub.close(() => r()));
  }
});
