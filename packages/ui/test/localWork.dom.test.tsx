import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@slackoss/client-core";
import { ClientContext, PlatformContext } from "../src/context.js";
import { Composer } from "../src/components/Composer.js";
import { DraftPersistence } from "../src/components/DraftPersistence.js";
import { webPlatform, type Platform } from "../src/platform.js";
import { readWorkspaceStorage, workspaceStorageKey } from "../src/lib/workspaceStorage.js";
import { trustWorkspaceAddress } from "../src/lib/workspaceAddressTrust.js";
import { sharedDevice } from "./sharedDevice.js";

/**
 * Local work is kept through a storage step every window shares (F01):
 * setting a key up never replaces what another window stored (GL-01), a
 * send's words stay in the box until the device keeps the send (GL-02), and
 * two windows writing the same draft keep both texts (GL-03).
 */
const clients: WorkspaceClient[] = [];
const releases: (() => void)[] = [];

function signedIn(workspaceId?: string) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    status: "online",
    workspaceId: workspaceId ?? null,
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
  } as never);
  clients.push(client);
  return client;
}

/** Types into the box and presses Enter, in one turn, as a fast typist does. */
async function typeAndSend(box: HTMLTextAreaElement, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const client of clients.splice(0)) client.destroy();
  cleanup();
  vi.restoreAllMocks();
});

describe("setting up a key another window is setting up too (GL-01)", () => {
  const key = workspaceStorageKey("http://127.0.0.1:9", "W1", "U1", "last-conversation")!;

  it.each([
    ["web", () => webPlatform()],
    ["desktop", () => sharedDevice().window()],
  ] as const)(
    "never replaces what another window stored after this one read nothing (%s)",
    async (_, make) => {
      const platform: Platform = make();
      const other: Platform = platform;
      // This window reads nothing; another stores a value before it records that.
      const get = platform.storage.get;
      let raced = false;
      platform.storage.get = async (name, options) => {
        const value = await get(name, options);
        if (!raced && name === key.key) {
          raced = true;
          await other.storage.set(key.key, { version: 1, value: "C_OTHER" });
        }
        return value as never;
      };
      expect(await readWorkspaceStorage<string>(platform, key)).toBe("C_OTHER");
      platform.storage.get = get;
      expect(await platform.storage.get(key.key)).toEqual({ version: 1, value: "C_OTHER" });
    },
  );

  it("keeps the old address's value when another window set the key up first", async () => {
    const platform = webPlatform();
    await trustWorkspaceAddress(platform, "W1", "U1", "http://127.0.0.1:9");
    await platform.storage.set(key.legacyKey!, "C_LEGACY");
    const get = platform.storage.get;
    let raced = false;
    platform.storage.get = async (name, options) => {
      const value = await get(name, options);
      if (!raced && name === key.legacyKey) {
        raced = true;
        await platform.storage.set(key.key, { version: 1, value: "C_NEWER" });
      }
      return value as never;
    };
    expect(await readWorkspaceStorage<string>(platform, key)).toBe("C_NEWER");
    platform.storage.get = get;
    expect(await platform.storage.get(key.key)).toEqual({ version: 1, value: "C_NEWER" });
    // Not retired: nothing was copied from it.
    expect(await platform.storage.get(key.legacyKey!)).toBe("C_LEGACY");
  });
});

describe("a send's words before the device keeps it (GL-02)", () => {
  function mount(platform: Platform, client: WorkspaceClient) {
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <DraftPersistence platform={platform} />
          <Composer channelId="C1" placeholder="Message test" />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message test" });
  }

  it("stay in the box until the outbox write is acknowledged, then go", async () => {
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
    const box = mount(platform, client);
    await waitFor(() => expect(device.values.has("outbox:http://127.0.0.1:9:U1")).toBe(true));

    await typeAndSend(box, "fresh words");
    await waitFor(() => expect(held).toBe(true));
    // Held: the words are still here, and cannot be sent twice meanwhile.
    expect(box.value).toBe("fresh words");
    expect(box.readOnly).toBe(true);
    act(() => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(client.state.pending).toHaveLength(1);

    resume();
    await waitFor(() => expect(box.value).toBe(""));
    expect(box.readOnly).toBe(false);
    expect(JSON.stringify(device.values.get("outbox:http://127.0.0.1:9:U1"))).toContain(
      "fresh words",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("are saved for a restart when the outbox write fails, and the box says nothing is lost", async () => {
    const device = sharedDevice();
    const platform = device.window();
    const client = signedIn();
    vi.spyOn(client.api, "sendMessage").mockImplementation(() => new Promise(() => {}));
    const merge = platform.storage.mergeOutbox!;
    platform.storage.mergeOutbox = async (...args) => {
      if (args[1].put.length) throw new Error("quota exceeded");
      return merge(...args);
    };
    const box = mount(platform, client);
    await waitFor(() => expect(device.values.has("outbox:http://127.0.0.1:9:U1")).toBe(true));

    await typeAndSend(box, "words kept another way");
    await waitFor(() => expect(box.value).toBe(""));
    // Kept under the unstored-sends key, which a restart puts back in the composer.
    expect(JSON.stringify(device.values.get("unstored-sends:http://127.0.0.1:9:U1"))).toContain(
      "words kept another way",
    );
  });

  it("go with a warning when nothing on the device could keep them", async () => {
    const device = sharedDevice();
    const platform = device.window();
    const client = signedIn();
    vi.spyOn(client.api, "sendMessage").mockImplementation(() => new Promise(() => {}));
    const box = mount(platform, client);
    await waitFor(() => expect(device.values.has("outbox:http://127.0.0.1:9:U1")).toBe(true));
    platform.storage.mergeOutbox = async () => {
      throw new Error("storage gone");
    };
    platform.storage.set = async () => {
      throw new Error("storage gone");
    };

    await typeAndSend(box, "only in memory");
    await waitFor(() => expect(box.value).toBe(""));
    expect(
      screen
        .getAllByRole("alert")
        .map((a) => a.textContent)
        .join(" "),
    ).toMatch(/could not be saved on this device\. Keep this window open/);
    // Sent once, not queued twice.
    expect(client.state.pending).toHaveLength(1);
  });
});

describe("two windows writing the same draft (GL-03)", () => {
  it("keeps both texts, and says so", async () => {
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
    await waitFor(
      () => {
        const stored = (device.values.get(key) as Record<string, string>).C1 ?? "";
        expect(stored).toContain("first competing text");
        expect(stored).toContain("second competing text");
      },
      { timeout: 3000 },
    );
    await waitFor(() => {
      for (const client of [first, second]) {
        expect(client.state.drafts.C1).toContain("first competing text");
        expect(client.state.drafts.C1).toContain("second competing text");
      }
    });
    expect(
      screen
        .getAllByRole("status")
        .map((s) => s.textContent)
        .join(" "),
    ).toMatch(/both versions are kept/);
  });

  it("keeps a draft typed in one window when another, still showing it, clears it", async () => {
    const device = sharedDevice({ "drafts:http://127.0.0.1:9:U1": { C1: "start" } });
    const first = signedIn();
    const second = signedIn();
    for (const client of [first, second])
      render(
        <ClientContext.Provider value={client}>
          <DraftPersistence platform={device.window()} />
        </ClientContext.Provider>,
      );
    const key = "drafts:http://127.0.0.1:9:U1";
    await waitFor(() => expect(second.state.drafts.C1).toBe("start"));
    await waitFor(() => expect(first.state.drafts.C1).toBe("start"));
    act(() => {
      first.setDraft("C1", "start, and more typed here");
      second.setDraft("C1", "");
    });
    await waitFor(
      () =>
        expect((device.values.get(key) as Record<string, string>).C1).toBe(
          "start, and more typed here",
        ),
      { timeout: 3000 },
    );
  });

  it("still writes different drafts from two windows side by side, and a clear sticks", async () => {
    const device = sharedDevice();
    const first = signedIn();
    const second = signedIn();
    for (const client of [first, second])
      render(
        <ClientContext.Provider value={client}>
          <DraftPersistence platform={device.window()} />
        </ClientContext.Provider>,
      );
    const key = "drafts:http://127.0.0.1:9:U1";
    await waitFor(() => expect(device.values.has(key)).toBe(true));
    act(() => {
      first.setDraft("C1", "channel words");
      second.setDraft("C1:T1", "thread words");
    });
    await waitFor(
      () =>
        expect(device.values.get(key)).toEqual({ C1: "channel words", "C1:T1": "thread words" }),
      { timeout: 3000 },
    );
    await waitFor(() => expect(second.state.drafts.C1).toBe("channel words"));
    act(() => first.setDraft("C1", ""));
    await waitFor(() => expect(device.values.get(key)).toEqual({ "C1:T1": "thread words" }), {
      timeout: 3000,
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
