import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

/** A real PNG of the given size, so the server reads its dimensions as it would a photo's. */
function solidPng(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x5a);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type), body]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let server: ChildProcess;
let data: string;
let claimCode = "";
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
      // These scenarios seed history by posting hundreds of messages in a
      // loop, which is the bulk import the limits are meant to refuse. What
      // is under test here is the browser, and rationing has its own suite.
      "--no-rate-limits",
    ],
    { windowsHide: true, stdio: "pipe" },
  );
  let startupOutput = "";
  server.stdout!.on("data", (chunk) => {
    startupOutput += String(chunk);
    claimCode = startupOutput.match(/Claim code: (\S+)/)?.[1] ?? "";
  });
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

/**
 * Opens the join screen at the workspace's own address. A browser served by a
 * workspace goes straight to its sign-in card, so the address field is only
 * there when the app has to ask which workspace is meant.
 */
async function openAuthCard(page: Page) {
  const address = page.getByPlaceholder("192.168.1.42:8543 or chat.yourteam.dev");
  const username = page.getByLabel("Username", { exact: true });
  // Whichever the join screen settles on: a served browser skips the list.
  await expect(address.or(username).first()).toBeVisible();
  if (await address.isVisible().catch(() => false)) {
    await address.fill(base);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
  }
  await expect(username).toBeVisible();
}

/** The same, from a cold load. */
async function reachAuthCard(page: Page) {
  await page.goto(base);
  await openAuthCard(page);
}

async function register(page: Page, handle: string, claim?: string) {
  await reachAuthCard(page);
  const create = page.getByRole("tab", { name: "Create account", exact: true });
  if (await create.isVisible()) await create.click();
  await page.getByLabel("Username", { exact: true }).fill(handle);
  await page.getByLabel("Display name", { exact: true }).fill(handle);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  if (claim) {
    await page.getByLabel("Workspace claim code", { exact: true }).fill("incorrect-code");
    await page.getByRole("button", { name: "Join workspace", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("not accepted");
    await expect(page.getByLabel("Username", { exact: true })).toHaveValue(handle);
    await page.getByLabel("Workspace claim code", { exact: true }).fill(claim);
  }
  await page.getByRole("button", { name: "Join workspace", exact: true }).click();
  await expect(page.locator("textarea")).toBeVisible();
}

/** Signs an existing account in, rather than creating one. */
async function signIn(page: Page, handle: string) {
  await reachAuthCard(page);
  const signInTab = page.getByRole("tab", { name: "Sign in", exact: true }).first();
  if (await signInTab.isVisible().catch(() => false)) await signInTab.click();
  await page.getByLabel("Username", { exact: true }).fill(handle);
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await expect(page.locator("textarea")).toBeVisible();
}

test("a browser served by a workspace offers that workspace without being asked", async ({
  page,
}) => {
  await page.goto(base);
  // The page came from the workspace, so there is nothing to look up: it goes
  // straight to signing in, named, with no address to type.
  await expect(page.getByRole("heading", { name: "Product Test" })).toBeVisible();
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("192.168.1.42:8543 or chat.yourteam.dev")).toHaveCount(0);

  // The way back to the full list is still there for a second workspace.
  await page.getByRole("button", { name: "All workspaces", exact: true }).click();
  await expect(page.getByPlaceholder("192.168.1.42:8543 or chat.yourteam.dev")).toBeVisible();
  await expect(page.getByText("serving this page")).toBeVisible();
});

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
    // A blocked resource is reported to the console rather than thrown, so it
    // would slip past the page-error check above on its own.
    page.on("console", (m) => {
      if (m.text().includes("Content Security Policy")) errors.push(m.text());
    });
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
    // A reverse proxy removes the localhost claim bypass. The owner can still
    // complete setup in the browser, including correcting an invalid code.
    await expect.poll(() => claimCode.length).toBeGreaterThan(0);
    await alice.route("**/api/**", (route) =>
      route.continue({
        headers: { ...route.request().headers(), "x-forwarded-for": "192.0.2.10" },
      }),
    );
    await register(alice, "alice", claimCode);
    await alice.unroute("**/api/**");
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
    // The video gets a stage of its own above the chat, with Alice named on it.
    const bobStage = bob.getByRole("region", { name: "Huddle video" });
    await expect(bobStage.getByRole("group", { name: "alice", exact: true })).toBeVisible();
    await alice.getByTitle("Mute", { exact: true }).click();
    await expect(alice.getByTitle("Unmute", { exact: true })).toBeVisible();
    // Muting is signalled, not guessed: Bob's copy of Alice says so.
    await expect(bob.getByTitle("alice (muted)")).toBeVisible();
    await expect(bobStage.getByRole("group", { name: "alice, muted", exact: true })).toBeVisible();
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
  // A blocked resource is reported to the console rather than thrown, so it
  // would slip past the page-error check above on its own.
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) errors.push(m.text());
  });
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

test("Gatherline keeps a capped live timeline pinned and supports keyboard and narrow-window chat", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A blocked resource is reported to the console rather than thrown, so it
  // would slip past the page-error check above on its own.
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) errors.push(m.text());
  });
  await page.goto(base);
  await expect(page).toHaveTitle("Gatherline");
  await page.screenshot({ path: info.outputPath("gatherline-welcome.png") });
  await register(page, "smoothness");
  const token = await page.evaluate(
    () => JSON.parse(localStorage.getItem("slackoss:servers")!)[0].token,
  );
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const response = await fetch(`${base}/api/channels`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ type: "public", name: "design-studio" }),
  });
  expect(response.ok).toBe(true);
  const { channel } = await response.json();
  await page.getByRole("navigation").getByRole("button", { name: "design-studio" }).click();
  for (const name of ["announcements", "engineering", "game-night"]) {
    expect(
      (
        await fetch(`${base}/api/channels`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ type: "public", name }),
        })
      ).ok,
    ).toBe(true);
  }
  const teammate = await (
    await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "maya", displayName: "Maya Chen", password: "password123" }),
    })
  ).json();
  expect(teammate.token).toBeTruthy();
  expect(
    (
      await fetch(`${base}/api/channels/${channel.id}/join`, {
        method: "POST",
        headers: { authorization: `Bearer ${teammate.token}` },
      })
    ).ok,
  ).toBe(true);
  const messages = [
    {
      token,
      text: "Welcome to #design-studio 👋\nA little space for big ideas. Share what you’re working on, ask for feedback, and make yourself at home.",
    },
    {
      token: teammate.token,
      text: "The new direction is ready for a first look.\n• Clearer navigation\n• More room for the conversation\n• A calmer palette that feels good all day",
    },
    {
      token,
      text: "Love where this is heading. Let’s jump into a huddle after lunch and walk through it together. 🎧",
    },
  ];
  for (const message of messages) {
    expect(
      (
        await fetch(`${base}/api/channels/${channel.id}/messages`, {
          method: "POST",
          headers: { ...auth, authorization: `Bearer ${message.token}` },
          body: JSON.stringify({ text: message.text }),
        })
      ).ok,
    ).toBe(true);
  }
  await expect(page.getByText(messages[2]!.text, { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("gatherline-conversation.png") });
  await page.getByRole("article").last().focus();
  await expect(page.getByTitle("Reply in thread", { exact: true }).last()).toBeVisible();
  await page.getByRole("textbox", { name: "Message #design-studio", exact: true }).focus();
  for (let i = 0; i < 315; i++) {
    const posted = await fetch(`${base}/api/channels/${channel.id}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: `Live update ${i} — keeping everyone on the same page.` }),
    });
    expect(posted.ok).toBe(true);
  }
  await expect(page.locator("[data-mid]")).toHaveCount(300);
  const history = page.getByLabel("Message history", { exact: true });
  await expect
    .poll(() => history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(4);
  await expect(
    page.getByText("Live update 314 — keeping everyone on the same page.", { exact: true }),
  ).toBeInViewport();

  // A side panel narrows the timeline and rewraps what is in it. Someone
  // reading the newest message should still see it, not find it under the
  // composer.
  const longUpdate = Array(6)
    .fill("a longer note that wraps onto more lines once the timeline narrows")
    .join(", ");
  expect(
    (
      await fetch(`${base}/api/channels/${channel.id}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text: longUpdate }),
      })
    ).ok,
  ).toBe(true);
  await expect(page.getByText(longUpdate, { exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Saved", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Later", exact: true })).toBeVisible();
  await expect
    .poll(() => history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(4);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Later", exact: true })).toHaveCount(0);

  // Observe input-to-next-frame timing in the built production client. Report
  // timings rather than imposing a machine-dependent "60 fps" CI promise.
  await page.evaluate(() => {
    (window as any).inputFrames = [];
    document.querySelector("textarea")!.addEventListener("input", () => {
      const start = performance.now();
      requestAnimationFrame(() => (window as any).inputFrames.push(performance.now() - start));
    });
  });
  const composer = page.getByRole("textbox", { name: "Message #design-studio", exact: true });
  await composer.pressSequentially("A calmer space for our next big idea.", { delay: 12 });
  // Allow the debounced draft write, then verify a dialog round trip keeps it.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some(
          (key) =>
            key.startsWith("slackoss:local:v1:") &&
            key.endsWith(":drafts") &&
            localStorage.getItem(key)?.includes("calmer space"),
        ),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Saved", exact: true }).click();
  const savedPanel = page.getByRole("complementary", { name: "Later", exact: true });
  await expect(savedPanel).toBeVisible();
  await composer.focus();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Jump to", exact: true });
  await expect(dialog).toBeVisible();
  // Workspace shortcuts must not replace a foreground form, and Escape must
  // leave the background side panel open when it dismisses that form.
  await page.keyboard.press("Control+f");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Search messages" })).toHaveCount(0);
  const lastButton = dialog.getByRole("button").last();
  await lastButton.focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(composer).toBeFocused();
  await expect(savedPanel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(savedPanel).toHaveCount(0);
  await expect(composer).toHaveValue("A calmer space for our next big idea.");
  await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(composer).toHaveValue("A calmer space for our next big idea.");

  // Completing a mention rewrites the whole field, and typing straight after
  // has to carry on from where the completion left off.
  await composer.fill("");
  await composer.pressSequentially("Hi @may", { delay: 10 });
  await page.keyboard.press("Tab");
  const completed = await composer.inputValue();
  expect(completed).toMatch(/^Hi <@[A-Z0-9]+> $/);
  await composer.pressSequentially("ready?", { delay: 5 });
  expect(await composer.inputValue()).toBe(`${completed}ready?`);

  // Formatting is where the caret has to land in the middle rather than at the
  // end: bolding a word should leave the word selected, ready to keep typing
  // over, not drop the caret past the closing marker.
  await composer.fill("hello world");
  await composer.evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(0, 5));
  await page.keyboard.press("Control+b");
  await expect(composer).toHaveValue("*hello* world");
  const selection = await composer.evaluate((el) => {
    const box = el as HTMLTextAreaElement;
    return [box.selectionStart, box.selectionEnd];
  });
  expect(selection).toEqual([1, 6]);
  await composer.fill("A calmer space for our next big idea.");

  // The switcher takes Enter too, and an input method's Enter is not a
  // request to go anywhere.
  await page.keyboard.press("Control+k");
  const switcher = page.getByRole("dialog", { name: "Jump to", exact: true });
  await expect(switcher).toBeVisible();
  await switcher
    .getByRole("textbox")
    .dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(switcher).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(composer).toBeFocused();

  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(composer).toBeEmpty();
  await expect(
    page.getByText("A calmer space for our next big idea.", { exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: info.outputPath("gatherline-workspace.png") });
  const timings = await page.evaluate(() =>
    ((window as any).inputFrames as number[]).sort((a, b) => a - b),
  );
  expect(timings.length).toBeGreaterThan(20);
  await info.attach("input-to-frame-ms", {
    body: JSON.stringify(
      {
        samples: timings.length,
        p50: timings[Math.floor(timings.length * 0.5)],
        p95: timings[Math.floor(timings.length * 0.95)],
        max: timings.at(-1),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByRole("navigation")).not.toBeVisible();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).click();
  await expect(page.getByRole("navigation")).not.toBeVisible();
  await page.keyboard.press("Escape");
  await composer.fill("Sent from a small window");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Sent from a small window", { exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // An image wider than a phone's column scales down instead of running off it.
  const upload = new FormData();
  upload.append("file", new Blob([solidPng(640, 360)], { type: "image/png" }), "wide-mock.png");
  const uploaded = await (
    await fetch(`${base}/api/channels/${channel.id}/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: upload,
    })
  ).json();
  expect(
    (
      await fetch(`${base}/api/channels/${channel.id}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text: "The wide mock", fileIds: [uploaded.file.id] }),
      })
    ).ok,
  ).toBe(true);
  const preview = page.getByRole("button", { name: "Open image wide-mock.png", exact: true });
  await expect(preview).toBeInViewport();
  const previewBox = await preview.boundingBox();
  expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(390);
  expect(await history.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("gatherline-narrow.png") });
  expect(errors).toEqual([]);
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
  // A blocked resource is reported to the console rather than thrown, so it
  // would slip past the page-error check above on its own.
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) errors.push(m.text());
  });
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
  // A blocked resource is reported to the console rather than thrown, so it
  // would slip past the page-error check above on its own.
  page.on("console", (m) => {
    if (m.text().includes("Content Security Policy")) errors.push(m.text());
  });
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

test("deactivating someone signs them out of the app they already have open", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const leaverContext = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const ownerPage = await ownerContext.newPage();
  const leaverPage = await leaverContext.newPage();
  try {
    // Alice registered first, so she owns this workspace.
    await signIn(ownerPage, "alice");
    await register(leaverPage, "frank");
    await expect(leaverPage.locator("textarea")).toBeVisible();

    await ownerPage.getByRole("button", { name: "Workspace", exact: true }).click();
    await ownerPage.getByRole("menuitem", { name: "People", exact: true }).click();
    const dialog = ownerPage.getByRole("dialog", { name: "People" });
    await expect(dialog).toBeVisible();

    // The owner's own row offers nothing: you cannot lock yourself out.
    const ownerRow = dialog.locator("li").filter({ hasText: "@alice" });
    await expect(ownerRow.getByRole("button")).toHaveCount(0);

    const leaverRow = dialog.locator("li").filter({ hasText: "@frank" });
    await leaverRow.getByRole("button", { name: "Actions for frank", exact: true }).click();
    await ownerPage.getByRole("menuitem", { name: "Deactivate", exact: true }).click();
    // Deactivated accounts drop out of the list, and are still reachable behind
    // a toggle, because reactivating is the other half of this.
    await expect(leaverRow).toHaveCount(0);
    await dialog.getByRole("button", { name: /Show 1 deactivated account/ }).click();
    await expect(
      dialog.locator("li").filter({ hasText: "@frank" }).getByText("Deactivated"),
    ).toBeVisible();

    // And the workspace remembers who did it.
    await dialog.getByRole("button", { name: "Show recent changes", exact: true }).click();
    await expect(
      dialog.getByRole("region", { name: "Recent changes" }).getByText("You deactivated frank"),
    ).toBeVisible();

    // Frank's open app does not keep working: it drops back to the join screen.
    await expect(leaverPage.getByText("Find your workspace", { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    // And signing back in from that same screen is refused.
    await openAuthCard(leaverPage);
    await expect(leaverPage.getByLabel("Username", { exact: true })).toBeVisible();
    const signInTab = leaverPage.getByRole("tab", { name: "Sign in", exact: true }).first();
    if (await signInTab.isVisible().catch(() => false)) await signInTab.click();
    await leaverPage.getByLabel("Username", { exact: true }).fill("frank");
    await leaverPage.getByLabel("Password", { exact: true }).fill("password123");
    await leaverPage.getByRole("button", { name: "Sign in", exact: true }).last().click();
    await leaverPage.waitForTimeout(1000);
    await expect(leaverPage.locator("textarea")).toHaveCount(0);
    await expect(leaverPage.getByLabel("Username", { exact: true })).toBeVisible();
  } finally {
    await ownerContext.close().catch(() => {});
    await leaverContext.close().catch(() => {});
  }
});

test("an admin who never copied a bot token can replace it, and the old one stops working", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  try {
    await signIn(page, "alice");
    // Every replacement asks first; this test means yes.
    page.on("dialog", (d) => void d.accept());

    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByRole("menuitem", { name: "Apps and integrations", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Apps and integrations" });
    await dialog.getByPlaceholder("App name, e.g. Deploy Bot").fill("Rotation Demo");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    const app = dialog.locator("li").filter({ hasText: "Rotation Demo" }).first();
    const tokenRow = app
      .locator("div")
      .filter({ hasText: /^Bot token · shown once/ })
      .first();
    const firstToken = (await tokenRow.locator("code").textContent())!;
    expect(firstToken.startsWith("xoxb-")).toBe(true);

    // Closing the dialog is how a token shown once gets lost.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByRole("menuitem", { name: "Apps and integrations", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Apps and integrations" });
    const reopened = dialog.locator("li").filter({ hasText: "Rotation Demo" }).first();
    await expect(reopened.getByText(/Bot token · shown once/)).toHaveCount(0);

    await reopened.getByRole("button", { name: "New bot token", exact: true }).click();
    const newRow = reopened
      .locator("div")
      .filter({ hasText: /^Bot token · shown once/ })
      .first();
    await expect(newRow).toBeVisible();
    const secondToken = (await newRow.locator("code").textContent())!;
    expect(secondToken.startsWith("xoxb-")).toBe(true);
    expect(secondToken).not.toBe(firstToken);

    const tryToken = async (token: string) =>
      (
        await (
          await fetch(`${base}/api/chat.postMessage`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ channel: "nowhere", text: "hello" }),
          })
        ).json()
      ).error;
    expect(await tryToken(firstToken)).toBe("invalid_auth");
    // Past authentication: refused for the channel, not for who is asking.
    expect(await tryToken(secondToken)).not.toBe("invalid_auth");
  } finally {
    await context.close().catch(() => {});
  }
});

test("an invite code that got out can be revoked from the dialog that made it", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  try {
    await signIn(page, "alice");
    page.on("dialog", (d) => void d.accept());

    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByRole("menuitem", { name: "Invite people", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Invite people" });
    await dialog.getByRole("button", { name: "Generate invite code", exact: true }).click();
    const code = (await dialog.locator("code.text-lg").textContent())!.trim();
    expect(code.length).toBeGreaterThan(4);

    // The new code is listed with the others, and usable.
    const codes = dialog.getByRole("list", { name: "Invite codes" });
    const row = codes.locator("li").filter({ hasText: code });
    await expect(row.getByText("Active", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: `Revoke invite ${code}`, exact: true }).click();
    await expect(row.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: `Revoke invite ${code}` })).toHaveCount(0);

    // And the server agrees, rather than only the list.
    const token = await page.evaluate(
      () => JSON.parse(localStorage.getItem("slackoss:servers")!)[0].token,
    );
    const { invites } = await (
      await fetch(`${base}/api/invites`, { headers: { authorization: `Bearer ${token}` } })
    ).json();
    expect(invites.find((i: { code: string }) => i.code === code).status).toBe("revoked");
  } finally {
    await context.close().catch(() => {});
  }
});

test("an invite link lets someone into an invite-only workspace from a browser, and a message link opens its message", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // A workspace of its own, invite-only, so the code the link carries is what
  // lets the new person in.
  const port = 18544;
  const origin = `http://127.0.0.1:${port}`;
  const inviteData = mkdtempSync(join(tmpdir(), "slackoss-e2e-invite-"));
  const inviteServer = spawn(
    process.execPath,
    [
      "apps/server-cli/dist/slackoss-server.js",
      "--data",
      inviteData,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-mdns",
      "--name",
      "Rocket Team",
      "--invite-only",
      "--no-rate-limits",
    ],
    { windowsHide: true, stdio: "pipe" },
  );
  const contexts: BrowserContext[] = [];
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`${origin}/api/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);

    // The owner, created from this machine, which needs no claim code.
    const registered = await (
      await fetch(`${origin}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "hana", displayName: "Hana", password: "password123" }),
      })
    ).json();
    const auth = {
      authorization: `Bearer ${registered.token}`,
      "content-type": "application/json",
    };
    const { channels } = await (await fetch(`${origin}/api/channels`, { headers: auth })).json();
    const general = channels.find((c: { name: string }) => c.name === "general");
    const post = async (text: string) => {
      const response = await fetch(`${origin}/api/channels/${general.id}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text }),
      });
      expect(response.status).toBe(201);
      return (await response.json()).message as { id: string };
    };
    // A message far enough back that opening it means going to find it.
    const plan = await post("The launch plan lives in the design doc");
    for (let i = 0; i < 80; i++) await post(`standup note ${i}`);
    const latest = await post("Latest update before the invite");
    const messageLink = (id: string) => `${origin}/#/c/${general.id}/m/${id}`;

    const host = await browser.newContext({
      viewport: { width: 1280, height: 820 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    contexts.push(host);
    const hostPage = await host.newPage();
    await hostPage.goto(origin);
    await hostPage.evaluate(
      (server) => localStorage.setItem("slackoss:servers", JSON.stringify([server])),
      {
        url: origin,
        token: registered.token,
        workspaceName: "Rocket Team",
        handle: "hana",
        lastUsedAt: Date.now(),
      },
    );
    await hostPage.reload();
    await expect(
      hostPage.getByText("Latest update before the invite", { exact: true }),
    ).toBeVisible();

    // The link is a browser's, built on the address this browser uses. That
    // address is this computer's own, and the dialog says so.
    await hostPage.getByRole("button", { name: "Workspace", exact: true }).click();
    await hostPage.getByRole("menuitem", { name: "Invite people", exact: true }).click();
    const dialog = hostPage.getByRole("dialog", { name: "Invite people" });
    await dialog.getByRole("button", { name: "Generate invite code", exact: true }).click();
    const code = (await dialog.locator("code.text-lg").textContent())!.trim();
    const inviteLink = `${origin}/#/join/${code}`;
    await expect(dialog.getByText(inviteLink, { exact: true })).toBeVisible();
    await expect(
      dialog.getByText(`gatherline://join?host=127.0.0.1:${port}&code=${code}`, { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText(/reaches only this computer/)).toBeVisible();
    await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
    expect(await hostPage.evaluate(() => navigator.clipboard.readText())).toBe(inviteLink);

    // A browser gives no Clipboard API to a page served over plain http from
    // another computer, which is how a workspace on a network is usually
    // reached. Copying still works there, from inside the dialog too.
    await hostPage.evaluate(() => {
      const api = Object.getOwnPropertyDescriptor(Clipboard.prototype, "writeText")!;
      Object.defineProperty(Clipboard.prototype, "writeText", { ...api, value: undefined });
      (window as unknown as { restoreClipboard: () => void }).restoreClipboard = () =>
        Object.defineProperty(Clipboard.prototype, "writeText", api);
    });
    await dialog.getByRole("button", { name: "Copy desktop link", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await hostPage.evaluate(() => navigator.clipboard.readText())).toBe(
      `gatherline://join?host=127.0.0.1:${port}&code=${code}`,
    );
    await hostPage.evaluate(() =>
      (window as unknown as { restoreClipboard: () => void }).restoreClipboard(),
    );
    await hostPage.keyboard.press("Escape");

    // Someone who has never been here opens it: the account form, code filled in.
    const guest = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    contexts.push(guest);
    const guestPage = await guest.newPage();
    await guestPage.goto(inviteLink);
    await expect(guestPage.getByRole("heading", { name: "Rocket Team" })).toBeVisible();
    await expect(guestPage.getByLabel("Invite code", { exact: true })).toHaveValue(code);
    // Read once, and gone from the address, so a reload or the history does not hold it.
    await expect(guestPage).toHaveURL(`${origin}/`);
    await guestPage.getByLabel("Username", { exact: true }).fill("ivy");
    await guestPage.getByLabel("Display name", { exact: true }).fill("Ivy");
    await guestPage.getByLabel("Password", { exact: true }).fill("password123");
    await guestPage.getByRole("button", { name: "Join workspace", exact: true }).click();
    await expect(guestPage.locator("textarea")).toBeVisible();
    await expect(
      guestPage.getByText("Latest update before the invite", { exact: true }),
    ).toBeVisible();

    // Copying a message's link gives the browser form of it.
    const latestRow = hostPage.locator(`[data-mid="${latest.id}"]`);
    await latestRow.hover();
    await latestRow.getByTitle("Copy link to message", { exact: true }).click();
    expect(await hostPage.evaluate(() => navigator.clipboard.readText())).toBe(
      messageLink(latest.id),
    );

    // Pasted into the address bar of the page already open, a message link
    // goes to the message, however far back it is.
    const planText = guestPage.getByText("The launch plan lives in the design doc", {
      exact: true,
    });
    await expect(planText).toHaveCount(0);
    await guestPage.goto(messageLink(plan.id));
    await expect(planText).toBeInViewport();
    await expect(guestPage).toHaveURL(`${origin}/`);

    // Opened by someone signed out, it waits for them to sign in.
    const later = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    contexts.push(later);
    const laterPage = await later.newPage();
    await laterPage.goto(messageLink(plan.id));
    await laterPage.getByLabel("Username", { exact: true }).fill("ivy");
    await laterPage.getByLabel("Password", { exact: true }).fill("password123");
    await laterPage.getByLabel("Password", { exact: true }).press("Enter");
    await expect(
      laterPage.getByText("The launch plan lives in the design doc", { exact: true }),
    ).toBeInViewport();

    // A link to a message, sent in a message, opens it in place rather than
    // in another tab of the app.
    const planForHost = hostPage.getByText("The launch plan lives in the design doc", {
      exact: true,
    });
    await expect(planForHost).toHaveCount(0);
    await post(`${messageLink(plan.id)} is where the plan is`);
    const sent = hostPage.getByRole("link", { name: messageLink(plan.id), exact: true });
    await expect(sent).toBeInViewport({ ratio: 1 });
    const pagesBefore = host.pages().length;
    // At the start of the link: hovering the message raises its toolbar over
    // the far end of a line this long.
    await sent.click({ position: { x: 6, y: 6 } });
    await expect(planForHost).toBeInViewport();
    expect(host.pages()).toHaveLength(pagesBefore);
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    if (inviteServer.exitCode === null) {
      const exited = new Promise((resolve) => inviteServer.once("exit", resolve));
      inviteServer.kill();
      await exited;
    }
    rmSync(inviteData, { recursive: true, force: true });
  }
});

test("notifications are offered after sign-in, and one opens its message", async ({ browser }) => {
  const aliceCtx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  // A stand-in for the browser's Notification: permission starts undecided,
  // every showing is recorded, and clicks run like the real thing.
  await aliceCtx.addInitScript(() => {
    const instances: Array<{
      title: string;
      onclick: ((event: Event) => void) | null;
      close: () => void;
      closed: boolean;
    }> = [];
    let focusCalls = 0;
    const focus = window.focus.bind(window);
    window.focus = () => {
      focusCalls++;
      focus();
    };
    class FakeNotification {
      static permission = "default";
      static instances = instances;
      static focusCalls = () => focusCalls;
      static async requestPermission() {
        FakeNotification.permission = "granted";
        return "granted" as NotificationPermission;
      }
      onclick: ((event: Event) => void) | null = null;
      closed = false;
      title: string;
      constructor(title: string, options?: { body?: string }) {
        this.title = title;
        instances.push(this as unknown as (typeof instances)[number]);
        void options;
      }
      close() {
        this.closed = true;
      }
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
  });
  const bobCtx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  try {
    const alicePage = await aliceCtx.newPage();
    await signIn(alicePage, "alice");

    // The ask comes after signing in, not on the first click anywhere.
    const banner = alicePage.getByRole("region", { name: "Notifications" });
    await expect(banner).toBeVisible();
    await alicePage.getByRole("button", { name: "Turn on", exact: true }).click();
    await expect(banner).toHaveCount(0);

    // A DM from someone else notifies even while this page is in front:
    // nothing has to steal its focus first.
    const bobPage = await bobCtx.newPage();
    await signIn(bobPage, "bobby");
    const token = await bobPage.evaluate(
      () => JSON.parse(localStorage.getItem("slackoss:servers")!)[0].token,
    );
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const { users } = await (await fetch(`${base}/api/users`, { headers: auth })).json();
    const alice = users.find((u: { handle: string }) => u.handle === "alice");
    const dm = await (
      await fetch(`${base}/api/channels`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ type: "dm", memberIds: [alice.id] }),
      })
    ).json();
    const posted = await (
      await fetch(`${base}/api/channels/${dm.channel.id}/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ text: "browser notification check" }),
      })
    ).json();
    const messageId = posted.message.id as string;
    await alicePage.waitForFunction(() => {
      const notes = (window.Notification as unknown as { instances: unknown[] }).instances;
      return notes.length > 0;
    });

    // Clicking it focuses the app and jumps to the message, highlighted.
    await alicePage.evaluate(() => {
      const notes = (
        window.Notification as unknown as {
          instances: Array<{ onclick: ((event: Event) => void) | null }>;
        }
      ).instances;
      notes[0]!.onclick!(new Event("click"));
    });
    await alicePage.waitForFunction(
      (id: string) => {
        const row = document.querySelector(`[data-mid="${CSS.escape(id)}"]`);
        if (!row) return false;
        for (const el of row.querySelectorAll("*")) {
          if (el.classList.contains("bg-copper/15")) return true;
        }
        return false;
      },
      messageId,
      { timeout: 10_000 },
    );
    const focusCalls = await alicePage.evaluate(() =>
      (window.Notification as unknown as { focusCalls: () => number }).focusCalls(),
    );
    expect(focusCalls).toBeGreaterThan(0);
  } finally {
    await aliceCtx.close().catch(() => {});
    await bobCtx.close().catch(() => {});
  }
});
