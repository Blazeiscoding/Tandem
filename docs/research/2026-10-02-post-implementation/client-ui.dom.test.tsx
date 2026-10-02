import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@slackoss/client-core";
import { ClientContext, PlatformContext } from "../../../packages/ui/src/context.js";
import { Composer } from "../../../packages/ui/src/components/Composer.js";
import { DraftPersistence } from "../../../packages/ui/src/components/DraftPersistence.js";
import { webPlatform, type Platform } from "../../../packages/ui/src/platform.js";
import {
  notificationContent,
  previewAccount,
  previewFor,
  useNotificationPreviews,
} from "../../../packages/ui/src/lib/notificationPreview.js";
import {
  checkWorkspaceAddress,
  trustWorkspaceAddress,
} from "../../../packages/ui/src/lib/workspaceAddressTrust.js";
import { sharedDevice } from "../../../packages/ui/test/sharedDevice.js";

const observations: Record<string, unknown>[] = [];
const clients: WorkspaceClient[] = [];
const releases: (() => void)[] = [];
type Previews = ReturnType<typeof useNotificationPreviews>;
const views = new Map<string, Previews>();
const KEY = "slackoss:notification-previews";

function PreviewReader({ label, account }: { label: string; account: string }) {
  const previews = useNotificationPreviews();
  views.set(label, previews);
  return <output aria-label={label}>{previewFor(previews, account)}</output>;
}

function mountPreview(platform: Platform, label: string, account: string) {
  return render(
    <PlatformContext.Provider value={platform}>
      <PreviewReader label={label} account={account} />
    </PlatformContext.Provider>,
  );
}

function signedIn() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "synthetic-not-a-live-token");
  client.store.setState({
    status: "online",
    self: {
      id: "U1",
      handle: "sam",
      displayName: "Sam",
      role: "member",
      statusText: "",
      statusEmoji: "",
      isBot: false,
      deactivated: false,
      dndUntil: null,
      createdAt: 0,
    },
    channels: {
      C1: {
        id: "C1",
        type: "public",
        name: "general",
        topic: "",
        description: "",
        creatorId: "U1",
        archived: false,
        createdAt: 0,
      },
    },
  });
  clients.push(client);
  return client;
}

beforeEach(() => {
  localStorage.clear();
  views.clear();
});
afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const client of clients.splice(0)) client.destroy();
  vi.restoreAllMocks();
});
afterAll(() => {
  writeFileSync(
    new NodeURL("client-ui-evidence.json", import.meta.url),
    JSON.stringify(
      {
        sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        runtime: { node: process.version, platform: process.platform },
        scope:
          "Production hooks, webPlatform and components in jsdom. Distinct Platform instances model open windows; localStorage is one jsdom realm. No independent browser process, native durability, layout, OS notification or latency certification.",
        observations,
      },
      null,
      2,
    ) + "\n",
  );
});

describe("post-implementation adjacent client boundaries", () => {
  it("malformed browser preferences load as full message previews without an error", async () => {
    localStorage.setItem(KEY, "{malformed");
    const account = previewAccount("http://127.0.0.1:9", "U1");
    mountPreview(webPlatform(), "corrupt-read", account);
    await waitFor(() => expect(views.get("corrupt-read")?.loaded).toBe(true));
    const state = views.get("corrupt-read")!;
    const preview = previewFor(state, account);
    const content = notificationContent(preview, {
      from: "Sam",
      channelName: "private",
      body: "synthetic private message",
    });
    expect({ preview, unreadable: state.unreadable, error: state.error }).toEqual({
      preview: "full",
      unreadable: false,
      error: null,
    });
    expect(content.body).toBe("synthetic private message");
    observations.push({
      name: "notification_corrupt_browser_read",
      classification: "new confirmed failure",
      preview,
      unreadable: state.unreadable,
      error: state.error,
      emittedContent: content,
      limitation: "Content helper is exercised; no actual OS notification is delivered.",
    });
  });

  it("strict storage rejection remains private in the generic platform control", async () => {
    const platform: Platform = {
      kind: "desktop",
      notify: () => {},
      storage: {
        get: async () => {
          throw new Error("synthetic unavailable storage");
        },
        set: async () => {},
      },
    };
    const account = previewAccount("http://127.0.0.1:9", "U1");
    mountPreview(platform, "rejected-read", account);
    await waitFor(() => expect(views.get("rejected-read")?.loaded).toBe(true));
    const state = views.get("rejected-read")!;
    expect(previewFor(state, account)).toBe("none");
    expect(state.unreadable).toBe(true);
    observations.push({
      name: "notification_rejected_read_control",
      classification: "correct control",
      preview: previewFor(state, account),
      unreadable: state.unreadable,
      errorShown: Boolean(state.error),
      limitation: "Injected generic platform rejection, not Electron IPC.",
    });
  });

  it("one open window can erase another account's acknowledged privacy choice", async () => {
    const accountA = previewAccount("http://127.0.0.1:9", "U1");
    const accountB = previewAccount("http://127.0.0.1:9", "U2");
    mountPreview(webPlatform(), "first-window", accountA);
    mountPreview(webPlatform(), "second-window", accountB);
    await waitFor(() =>
      expect(views.get("first-window")?.loaded && views.get("second-window")?.loaded).toBe(true),
    );
    await act(async () => views.get("first-window")!.setPreview(accountA, "none"));
    const acknowledgedA = JSON.parse(localStorage.getItem(KEY)!);
    expect(acknowledgedA[accountA]).toBe("none");
    // Deliver the event browsers deliver to another tab; the production hook has no listener.
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: KEY,
          newValue: JSON.stringify(acknowledgedA),
          storageArea: localStorage,
        }),
      ),
    );
    const secondHeardA = views.get("second-window")!.byAccount[accountA] ?? null;
    await act(async () => views.get("second-window")!.setPreview(accountB, "sender"));
    const persisted = JSON.parse(localStorage.getItem(KEY)!);
    mountPreview(webPlatform(), "reopened-first", accountA);
    await waitFor(() => expect(views.get("reopened-first")?.loaded).toBe(true));
    expect(persisted).toEqual({ [accountB]: "sender" });
    expect(previewFor(views.get("reopened-first")!, accountA)).toBe("full");
    observations.push({
      name: "notification_cross_window_lost_private_choice",
      classification: "new confirmed failure",
      acknowledgedA,
      secondHeardA,
      persisted,
      reopenedA: previewFor(views.get("reopened-first")!, accountA),
      concurrencyRequired: false,
      limitation:
        "Sequential writes and a simulated browser storage event in one DOM realm; actual independent tabs still need acceptance.",
    });
  });

  it("an already-open same-account window keeps full previews after another chooses private", async () => {
    const account = previewAccount("http://127.0.0.1:9", "U1");
    mountPreview(webPlatform(), "first-account-window", account);
    mountPreview(webPlatform(), "second-account-window", account);
    await waitFor(() =>
      expect(
        views.get("first-account-window")?.loaded && views.get("second-account-window")?.loaded,
      ).toBe(true),
    );
    await act(async () => views.get("first-account-window")!.setPreview(account, "none"));
    act(() =>
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: KEY,
          newValue: localStorage.getItem(KEY),
          storageArea: localStorage,
        }),
      ),
    );
    expect(previewFor(views.get("first-account-window")!, account)).toBe("none");
    expect(previewFor(views.get("second-account-window")!, account)).toBe("full");
    observations.push({
      name: "notification_open_window_stale_privacy",
      classification: "new confirmed failure",
      firstPreview: "none",
      secondPreview: "full",
      persisted: JSON.parse(localStorage.getItem(KEY)!),
      limitation:
        "Production hook and browser event in jsdom, not native notification deduplication.",
    });
  });

  it("an explicitly trusted alias of the same workspace loses the privacy choice", async () => {
    const platform = webPlatform();
    const original = "http://127.0.0.1:9";
    const alias = "http://localhost:9";
    await checkWorkspaceAddress(platform, "W1", "U1", original);
    await trustWorkspaceAddress(platform, "W1", "U1", alias);
    mountPreview(platform, "alias-original", previewAccount(original, "U1"));
    await waitFor(() => expect(views.get("alias-original")?.loaded).toBe(true));
    await act(async () =>
      views.get("alias-original")!.setPreview(previewAccount(original, "U1"), "none"),
    );
    mountPreview(platform, "alias-new", previewAccount(alias, "U1"));
    expect(previewFor(views.get("alias-new")!, previewAccount(alias, "U1"))).toBe("full");
    observations.push({
      name: "notification_trusted_alias_scope",
      classification: "new confirmed behavior needing privacy-policy decision",
      workspaceId: "W1",
      aliasesExplicitlyTrusted: [original, alias],
      originalPreview: "none",
      aliasPreview: "full",
      limitation:
        "Authentic address-trust/storage helpers with synthetic identity; no live alias navigation. Settings UI says workspace/device, while preference key uses address/user.",
    });
  });

  it("competing same-draft text is still replaced without preserving the other version", async () => {
    const device = sharedDevice();
    const first = signedIn();
    const second = signedIn();
    const mount = (client: WorkspaceClient) =>
      render(
        <ClientContext.Provider value={client}>
          <DraftPersistence platform={device.window()} />
        </ClientContext.Provider>,
      );
    mount(first);
    mount(second);
    const key = "drafts:http://127.0.0.1:9:U1";
    await waitFor(() => expect(device.values.has(key)).toBe(true));
    act(() => {
      first.setDraft("C1", "first competing text");
      second.setDraft("C1", "second competing text");
    });
    await waitFor(() => expect(device.values.get(key)).toEqual({ C1: "second competing text" }), {
      timeout: 3000,
    });
    expect(first.state.drafts.C1).toBe("second competing text");
    expect(second.state.drafts.C1).toBe("second competing text");
    expect(screen.queryByRole("alert")).toBeNull();
    observations.push({
      name: "same_draft_conflict_policy",
      classification: "inherited open GL-03 acceptance gap",
      persisted: device.values.get(key),
      firstTextRetained: JSON.stringify([
        ...device.values.values(),
        first.state.drafts,
        second.state.drafts,
      ]).includes("first competing text"),
      conflictAlertShown: false,
      limitation:
        "Production DraftPersistence, serialized sharedDevice test double, not native Electron or independent browser processes.",
    });
  });

  it("fresh send clears before a held local outbox write acknowledges it", async () => {
    const device = sharedDevice();
    const platform = device.window();
    const client = signedIn();
    vi.spyOn(client.api, "sendMessage").mockImplementation(() => new Promise(() => {}));
    let resume!: () => void;
    const until = new Promise<void>((resolve) => (resume = resolve));
    releases.push(resume);
    const merge = platform.storage.mergeOutbox!;
    let held = false;
    platform.storage.mergeOutbox = async (...args) => {
      if (args[1].put.length) {
        held = true;
        await until;
      }
      return merge(...args);
    };
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <DraftPersistence platform={platform} />
          <Composer channelId="C1" placeholder="Message test" />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message test" });
    await waitFor(() => expect(box).toBeEnabled());
    await waitFor(() => expect(device.values.has("outbox:http://127.0.0.1:9:U1")).toBe(true));
    // One synchronous input/send turn avoids both composer and persistence pause timers.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(box, "fresh unacknowledged words");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await waitFor(() => expect(held).toBe(true));
    expect(box.value).toBe("");
    const durableAtClear = JSON.stringify([...device.values.values()]).includes(
      "fresh unacknowledged words",
    );
    expect(durableAtClear).toBe(false);
    expect(client.state.pending).toHaveLength(1);
    observations.push({
      name: "fresh_send_acceptance_before_storage",
      classification: "inherited open GL-02 acceptance gap",
      composerCleared: true,
      durableTextAtClear: durableAtClear,
      inMemoryPending: client.state.pending.length,
      limitation:
        "Held serialized storage test double and pending API; proves clear precedes acknowledgement, not actual process-death loss.",
    });
    resume();
    await waitFor(() =>
      expect(JSON.stringify([...device.values.values()])).toContain("fresh unacknowledged words"),
    );
  });
});
