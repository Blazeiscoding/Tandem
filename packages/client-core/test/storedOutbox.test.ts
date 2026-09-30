import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OUTBOX_TOMBSTONES_KEPT,
  WorkspaceClient,
  applyOutboxChanges,
  emptyOutbox,
  mergeOutbox,
  outboxRevision,
  readStoredOutbox,
  unwrapStoredOutbox,
  type StoredOutbox,
  type StoredOutboxEntry,
} from "../src/index.js";

/**
 * The outbox every window on one account writes. Each writes only its own
 * changes, and the merge decides per send: a send taken out stays out, and
 * the newer of two versions of a send is kept.
 */
function entry(nonce: string, rev: number, extra: Partial<StoredOutboxEntry> = {}) {
  return {
    nonce,
    channelId: "C1",
    threadRootId: null,
    text: `text of ${nonce}`,
    userId: "U1",
    createdAt: 1,
    attachments: [],
    rev,
    ...extra,
  } satisfies StoredOutboxEntry;
}

const nonces = (outbox: StoredOutbox) => outbox.entries.map((e) => e.nonce);

describe("merging one window's changes into the stored outbox", () => {
  it("keeps what every window put, whichever wrote last", () => {
    let stored = emptyOutbox();
    stored = mergeOutbox(stored, { put: [entry("A", 10)], remove: [] });
    stored = mergeOutbox(stored, { put: [entry("B", 11)], remove: [] });
    expect(nonces(stored)).toEqual(["A", "B"]);
  });

  it("never puts back a send another window took out, however it comes back", () => {
    // Two windows restored A. One discards it; the other, still holding A,
    // writes everything it holds when it sends B.
    let stored = mergeOutbox(emptyOutbox(), { put: [entry("A", 0)], remove: [] });
    stored = mergeOutbox(stored, { put: [], remove: [{ nonce: "A", rev: 20 }] });
    stored = mergeOutbox(stored, { put: [entry("A", 0), entry("B", 30)], remove: [] });
    expect(nonces(stored)).toEqual(["B"]);
    // Not even a newer version of it: a nonce once delivered or discarded is done.
    stored = mergeOutbox(stored, { put: [entry("A", 40)], remove: [] });
    expect(nonces(stored)).toEqual(["B"]);
    expect(stored.removed).toEqual([{ nonce: "A", rev: 20 }]);
  });

  it("keeps a refusal against an older copy, and lets a newer Retry replace it", () => {
    const refused = entry("A", 20, { refusal: "This conversation is archived." });
    let stored = mergeOutbox(emptyOutbox(), { put: [refused], remove: [] });
    stored = mergeOutbox(stored, { put: [entry("A", 10)], remove: [] });
    expect(stored.entries).toEqual([refused]);
    // The same revision again changes nothing either.
    stored = mergeOutbox(stored, { put: [entry("A", 20)], remove: [] });
    expect(stored.entries).toEqual([refused]);

    stored = mergeOutbox(stored, { put: [entry("A", 30)], remove: [] });
    expect(stored.entries).toEqual([entry("A", 30)]);
  });

  it("keeps the newest tombstones, up to its limit", () => {
    const remove = Array.from({ length: OUTBOX_TOMBSTONES_KEPT + 5 }, (_, i) => ({
      nonce: `N${i}`,
      rev: i + 1,
    }));
    const stored = mergeOutbox(emptyOutbox(), { put: [], remove });
    expect(stored.removed).toHaveLength(OUTBOX_TOMBSTONES_KEPT);
    expect(stored.removed[0]).toEqual({ nonce: `N${OUTBOX_TOMBSTONES_KEPT + 4}`, rev: 505 });
    expect(stored.removed.at(-1)).toEqual({ nonce: "N5", rev: 6 });
  });

  it("stores only what a send is, not whatever else came with it", () => {
    const stored = mergeOutbox(emptyOutbox(), {
      put: [{ ...entry("A", 1), previewUrl: "blob:x" } as StoredOutboxEntry],
      remove: [],
    });
    expect(stored.entries[0]).toEqual(entry("A", 1));
  });
});

describe("reading what is stored", () => {
  it("reads the list an earlier version wrote as the oldest revision", () => {
    const { rev: _rev, ...legacy } = entry("A", 0);
    expect(readStoredOutbox([legacy])).toEqual({
      outbox: 2,
      entries: [entry("A", 0)],
      removed: [],
    });
    // A newer write of the same send wins over it.
    const upgraded = mergeOutbox(readStoredOutbox([legacy])!, { put: [entry("A", 5)], remove: [] });
    expect(upgraded.entries).toEqual([entry("A", 5)]);
  });

  it("refuses anything that is not an outbox", () => {
    expect(readStoredOutbox(null)).toEqual(emptyOutbox());
    expect(readStoredOutbox([{ nonce: 1 }])).toBeNull();
    expect(readStoredOutbox({ outbox: 3, entries: [], removed: [] })).toBeNull();
    expect(readStoredOutbox({ outbox: 2, entries: [entry("A", -1)], removed: [] })).toBeNull();
    expect(readStoredOutbox({ outbox: 2, entries: [], removed: [{ nonce: "A" }] })).toBeNull();
    expect(unwrapStoredOutbox([entry("A", 0)], true)).toBeNull();
  });

  it("replaces an unreadable value instead of refusing every later write", () => {
    const { value, outbox } = applyOutboxChanges(
      { version: 1, value: "garbage" },
      { put: [entry("A", 1)], remove: [] },
      true,
    );
    expect(value).toEqual({ version: 1, value: outbox });
    expect(nonces(outbox)).toEqual(["A"]);
  });
});

describe("revisions", () => {
  it("move forward from the last one and across milliseconds", () => {
    expect(outboxRevision(0, 1000)).toBe(1_000_000);
    expect(outboxRevision(1_000_000, 1000)).toBe(1_000_001);
    expect(outboxRevision(1_000_001, 1001)).toBe(1_001_000);
    expect(Number.isSafeInteger(outboxRevision(0, Date.UTC(2200, 0)))).toBe(true);
  });
});

describe("a refusal another window was given", () => {
  afterEach(() => vi.restoreAllMocks());

  function signedIn() {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({
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
      status: "online",
    });
    return client;
  }

  it("stops this window's send and waits for Retry, whatever this window then hears", async () => {
    const client = signedIn();
    let fail = () => {};
    const sendMessage = vi.spyOn(client.api, "sendMessage").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new TypeError("Failed to fetch"));
        }),
    );
    client.send("C1", "sent from two windows");
    const nonce = client.state.pending[0]!.nonce;

    client.adoptRefusal(nonce, "This conversation is archived.");
    // This window's own attempt then fails for want of a connection; that
    // says nothing new about the refusal.
    fail();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.state.pending[0]).toMatchObject({
      failed: true,
      refused: true,
      failureReason: "This conversation is archived.",
    });
    expect(client.outboxSnapshot()[0]!.refusal).toBe("This conversation is archived.");

    // Only the author's Retry sends it again.
    client.retrySend(nonce);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(client.state.pending[0]).toMatchObject({ failed: false, refused: false });
    client.destroy();
  });

  it("is not sent when it arrives while this window's files are still uploading", async () => {
    const client = signedIn();
    let uploaded = () => {};
    vi.spyOn(client.api, "uploadFile").mockImplementation(
      () =>
        new Promise((resolve) => {
          uploaded = () => resolve({ file: { id: "F1" } as never });
        }),
    );
    const sendMessage = vi.spyOn(client.api, "sendMessage");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    client.send("C1", "with a file", { files: [new File(["x"], "x.txt", { type: "text/plain" })] });
    const nonce = client.state.pending[0]!.nonce;

    client.adoptRefusal(nonce, "This conversation is archived.");
    uploaded();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(client.state.pending[0]).toMatchObject({ failed: true, refused: true });
    client.destroy();
  });
});
