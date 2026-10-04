import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@slackoss/client-core";
import { ClientContext, PlatformContext } from "../../../../packages/ui/src/context.js";
import { Composer } from "../../../../packages/ui/src/components/Composer.js";
import { WorkspaceStorageGate } from "../../../../packages/ui/src/components/WorkspaceStorageGate.js";
import { webPlatform, type Platform } from "../../../../packages/ui/src/platform.js";
import { CHANGE_KEY } from "../../../../packages/ui/src/lib/deviceStore.js";
import { useComposerPreferences } from "../../../../packages/ui/src/lib/composerPreferences.js";
import {
  previewFor,
  useNotificationPreviews,
} from "../../../../packages/ui/src/lib/notificationPreview.js";
import {
  checkWorkspaceAddress,
  workspaceAddressTrustKey,
} from "../../../../packages/ui/src/lib/workspaceAddressTrust.js";
import {
  readWorkspaceDrafts,
  workspaceStorageKey,
} from "../../../../packages/ui/src/lib/workspaceStorage.js";

const observed: Record<string, unknown> = {};
const account = "http://127.0.0.1:9 U1";
const home = "http://127.0.0.1:9";
const other = "http://127.0.0.1:10";
const person = {
  id: "U1",
  handle: "sam",
  displayName: "Sam",
  role: "member" as const,
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};
const room = {
  id: "C1",
  type: "public" as const,
  name: "general",
  topic: "",
  description: "",
  creatorId: "U1",
  archived: false,
  createdAt: 0,
  memberIds: ["U1"],
};
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function notifyStorage() {
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: CHANGE_KEY,
      newValue: localStorage.getItem(CHANGE_KEY),
      storageArea: localStorage,
    }),
  );
}
function clientAt(url = home) {
  const client = new WorkspaceClient(url, "synthetic-research-token");
  client.store.setState({
    self: person,
    users: { U1: person },
    channels: { C1: room },
    status: "online",
  });
  return client;
}
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", undefined);
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() =>
  writeFileSync(
    resolve(
      process.env.TANDEM_RESEARCH_ROOT!,
      "docs/research/2026-10-04-next/root/preferences-evidence.json",
    ),
    JSON.stringify(observed, null, 2) + "\n",
  ),
);

describe("diagnostic assertions for new preference/identity boundaries", () => {
  it("turns a saved newline preference into Enter-to-send on a refused IndexedDB record read", async () => {
    const healthy = webPlatform();
    await healthy.storage.set("composer-preferences", { enterSends: false });
    const original = IDBObjectStore.prototype.get;
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (
      this: IDBObjectStore,
      key,
    ) {
      if (key === "composer-preferences")
        throw new DOMException("Synthetic record read refusal", "UnknownError");
      return original.call(this, key);
    });
    const platform = webPlatform();
    const client = clientAt();
    const send = vi.spyOn(client, "send").mockReturnValue(true);
    let choice!: ReturnType<typeof useComposerPreferences>;
    function Preference() {
      choice = useComposerPreferences();
      return null;
    }
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <Preference />
          <Composer channelId="C1" placeholder="Message general" />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    await waitFor(() => expect(choice.loaded).toBe(true));
    const box = screen.getByRole("textbox", { name: "Message general" });
    await waitFor(() => expect(box).toBeEnabled());
    expect(choice.enterSends).toBe(true);
    expect(choice.error).toBeNull();
    fireEvent.change(box, { target: { value: "words intended to continue on a new line" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(send).toHaveBeenCalledOnce();
    await expect(platform.storage.get("composer-preferences", { strict: true })).rejects.toThrow(
      "refusal",
    );
    observed.composerReadRefusal = {
      savedEnterSends: false,
      loadedEnterSends: choice.enterSends,
      error: choice.error,
      sends: send.mock.calls.length,
    };
    client.destroy();
  });

  it("drops a stricter cross-window update while the initial notification read reply is held", async () => {
    const writer = webPlatform();
    await writer.storage.mergeRecord!("notification-previews", { [account]: "full" });
    const reader = webPlatform();
    const get = reader.storage.get;
    const gate = deferred();
    let snapshot!: unknown;
    const watch = reader.storage.watchRecord!;
    let heard = 0;
    reader.storage.watchRecord = (key, cb) =>
      watch(key, (value) => {
        heard++;
        cb(value);
      });
    reader.storage.get = async <T,>(key: string, options?: { strict?: boolean }) => {
      const value = await get<T>(key, options);
      if (key === "notification-previews") {
        snapshot = value;
        await gate.promise;
      }
      return value;
    };
    let state!: ReturnType<typeof useNotificationPreviews>;
    function Reader() {
      state = useNotificationPreviews();
      return null;
    }
    render(
      <PlatformContext.Provider value={reader}>
        <Reader />
      </PlatformContext.Provider>,
    );
    await waitFor(() => expect(snapshot).toEqual({ [account]: "full" }));
    await writer.storage.mergeRecord!("notification-previews", { [account]: "none" });
    await act(async () => notifyStorage());
    await waitFor(() => expect(heard).toBe(1));
    expect(state.loaded).toBe(false);
    await act(async () => gate.release());
    await waitFor(() => expect(state.loaded).toBe(true));
    expect(previewFor(state, account)).toBe("full");
    expect(await writer.storage.get("notification-previews", { strict: true })).toEqual({
      [account]: "none",
    });
    observed.notificationInitialReply = { durable: "none", displayed: previewFor(state, account) };
    // Control: the next focus refresh sees the stricter stored choice.
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(previewFor(state, account)).toBe("none"));
  });

  it("applies an old save reply over a newer private choice received from another window", async () => {
    const writer = webPlatform();
    await writer.storage.mergeRecord!("notification-previews", { [account]: "sender" });
    const reader = webPlatform();
    const merge = reader.storage.mergeRecord!;
    const gate = deferred();
    let committed = false;
    reader.storage.mergeRecord = async (key, changes) => {
      const value = await merge(key, changes);
      if (key === "notification-previews") {
        committed = true;
        await gate.promise;
      }
      return value;
    };
    let state!: ReturnType<typeof useNotificationPreviews>;
    function Reader() {
      state = useNotificationPreviews();
      return null;
    }
    render(
      <PlatformContext.Provider value={reader}>
        <Reader />
      </PlatformContext.Provider>,
    );
    await waitFor(() => expect(state.loaded).toBe(true));
    let saving!: Promise<void>;
    await act(async () => {
      saving = state.setPreview(account, "full");
    });
    await waitFor(() => expect(committed).toBe(true));
    await writer.storage.mergeRecord!("notification-previews", { [account]: "none" });
    await act(async () => notifyStorage());
    await waitFor(() => expect(previewFor(state, account)).toBe("none"));
    await act(async () => {
      gate.release();
      await saving;
    });
    expect(previewFor(state, account)).toBe("full");
    expect(await writer.storage.get("notification-previews", { strict: true })).toEqual({
      [account]: "none",
    });
    observed.notificationSaveReply = {
      durable: "none",
      receivedWhileSaving: "none",
      displayedAfterReply: previewFor(state, account),
    };
  });

  it("admits two distinct first addresses without approval and hands the second the first address's migrated draft", async () => {
    const first = webPlatform();
    const second = webPlatform();
    const trustKey = workspaceAddressTrustKey("W1", "U1");
    await first.storage.set(`drafts:${home}:U1`, { C1: "private draft at the first address" });
    const one = deferred();
    const two = deferred();
    let absentReads = 0;
    for (const [platform, gate] of [
      [first, one],
      [second, two],
    ] as const) {
      const get = platform.storage.get;
      let held = false;
      platform.storage.get = async <T,>(key: string, options?: { strict?: boolean }) => {
        const value = await get<T>(key, options);
        if (key === trustKey && !held) {
          held = true;
          expect(value).toBeNull();
          absentReads++;
          await gate.promise;
        }
        return value;
      };
    }
    const clients = [clientAt(home), clientAt(other)];
    clients.forEach((client) => client.store.setState({ workspaceId: "W1" }));
    const mounted: string[] = [];
    const drafts: Record<string, unknown> = {};
    function Work({ platform, url }: { platform: Platform; url: string }) {
      const key = workspaceStorageKey(url, "W1", "U1", "drafts")!;
      // This effect stands for a local-work consumer mounted by the production gate.
      useEffect(() => {
        mounted.push(url);
        void readWorkspaceDrafts(platform, key).then((value) => {
          drafts[url] = value;
        });
      }, []);
      return <div>{url}</div>;
    }
    render(
      <>
        <WorkspaceStorageGate
          platform={first}
          client={clients[0]!}
          onLeaveWorkspace={() => {}}
          onSignedOut={() => {}}
        >
          <Work platform={first} url={home} />
        </WorkspaceStorageGate>
        <WorkspaceStorageGate
          platform={second}
          client={clients[1]!}
          onLeaveWorkspace={() => {}}
          onSignedOut={() => {}}
        >
          <Work platform={second} url={other} />
        </WorkspaceStorageGate>
      </>,
    );
    await waitFor(() => expect(absentReads).toBe(2));
    await act(async () => one.release());
    await waitFor(() => expect(drafts[home]).toEqual({ C1: "private draft at the first address" }));
    await act(async () => two.release());
    await waitFor(() =>
      expect(drafts[other]).toEqual({ C1: "private draft at the first address" }),
    );
    expect(screen.queryByRole("dialog", { name: "Confirm workspace address" })).toBeNull();
    expect(mounted).toEqual([home, other]);
    observed.firstAddressRace = {
      absentReads,
      mounted,
      secondDraft: drafts[other],
      finalTrust: await first.storage.get(trustKey, { strict: true }),
    };
    clients.forEach((client) => client.destroy());
  });

  it("refuses the second address once the first registration is already committed", async () => {
    const first = webPlatform();
    const second = webPlatform();
    expect((await checkWorkspaceAddress(first, "W1", "U1", home)).allowed).toBe(true);
    const result = await checkWorkspaceAddress(second, "W1", "U1", other);
    expect(result.allowed).toBe(false);
    expect(result.addresses).toEqual([home]);
    observed.firstAddressSequentialControl = result;
  });
});
