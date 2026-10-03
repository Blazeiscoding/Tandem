/** Diagnostic assertions establish the current defect; they are not repair acceptance. */
import { writeFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import { render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlatformContext } from "../../../packages/ui/src/context.js";
import { deviceStore, LEGACY_PREFIX } from "../../../packages/ui/src/lib/deviceStore.js";
import { webPlatform, type Platform } from "../../../packages/ui/src/platform.js";
import {
  notificationContent,
  previewAccount,
  previewFor,
  useNotificationPreviews,
} from "../../../packages/ui/src/lib/notificationPreview.js";

const evidence: Record<string, unknown>[] = [];
const account = previewAccount("http://127.0.0.1:9", "U-review");
type Previews = ReturnType<typeof useNotificationPreviews>;
let state: Previews;
function Reader() {
  state = useNotificationPreviews();
  return null;
}
async function open(platform: Platform) {
  render(
    <PlatformContext.Provider value={platform}>
      <Reader />
    </PlatformContext.Provider>,
  );
  await waitFor(() => expect(state.loaded).toBe(true));
}
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() =>
  writeFileSync(
    new NodeURL("./root-storage-evidence.json", import.meta.url),
    JSON.stringify(
      {
        reviewedRevision: "cd3af584ba46adace45465cb5e5c66afb238b01c",
        method:
          "Production DeviceStore/webPlatform/notification hook with fake IndexedDB; expected-defect assertions",
        evidence,
      },
      null,
      2,
    ) + "\n",
  ),
);

it("an IndexedDB open failure silently changes a saved private preview to full", async () => {
  const healthy = webPlatform();
  await healthy.storage.mergeRecord!("notification-previews", { [account]: "none" });
  expect(await healthy.storage.get("notification-previews", { strict: true })).toEqual({
    [account]: "none",
  });
  expect(localStorage.getItem(LEGACY_PREFIX + "notification-previews")).toBe(null);
  vi.spyOn(indexedDB, "open").mockImplementation(() => {
    throw new DOMException("Opening refused", "UnknownError");
  });
  await open(webPlatform());
  expect(state.unreadable).toBe(false);
  expect(state.error).toBe(null);
  expect(previewFor(state, account)).toBe("full");
  const content = notificationContent(previewFor(state, account), {
    from: "Sam",
    body: "synthetic private words",
    channelName: "private",
  });
  evidence.push({
    case: "transient IndexedDB open failure after migration",
    savedPreview: "none",
    effectivePreview: previewFor(state, account),
    unreadable: state.unreadable,
    error: state.error,
    content,
  });
});

it("acknowledged fallback draft is discarded when IndexedDB becomes available again", async () => {
  const healthy = deviceStore();
  expect(await healthy.backend).toBe("indexeddb");
  await healthy.apply("drafts:review", {
    kind: "drafts",
    changes: { put: { C1: "before failure" }, remove: [] },
    enveloped: false,
  });
  const openFailure = vi.spyOn(indexedDB, "open").mockImplementation(() => {
    throw new DOMException("Opening refused", "UnknownError");
  });
  const fallback = deviceStore();
  expect(await fallback.backend).toBe("localstorage");
  expect(await fallback.read("drafts:review")).toBe(null);
  await fallback.apply("drafts:review", {
    kind: "drafts",
    changes: { put: { C1: "acknowledged during fallback" }, remove: [] },
    enveloped: false,
  });
  expect(JSON.parse((await fallback.read("drafts:review"))!)).toEqual({
    C1: "acknowledged during fallback",
  });
  openFailure.mockRestore();
  const recovered = deviceStore();
  expect(await recovered.backend).toBe("indexeddb");
  expect(JSON.parse((await recovered.read("drafts:review"))!)).toEqual({ C1: "before failure" });
  expect(localStorage.getItem(LEGACY_PREFIX + "drafts:review")).toBe(null);
  evidence.push({
    case: "fallback draft then recovered IndexedDB",
    fallbackAcknowledged: "acknowledged during fallback",
    recovered: JSON.parse((await recovered.read("drafts:review"))!),
    fallbackRawAfterRecovery: localStorage.getItem(LEGACY_PREFIX + "drafts:review"),
  });
});

it("missing BroadcastChannel skips an otherwise readable IndexedDB", async () => {
  const healthy = deviceStore();
  await healthy.apply("notification-previews", { kind: "record", changes: { [account]: "none" } });
  vi.stubGlobal("BroadcastChannel", undefined);
  const fallback = deviceStore();
  expect(await fallback.backend).toBe("localstorage");
  expect(await fallback.read("notification-previews")).toBe(null);
  evidence.push({
    case: "missing BroadcastChannel",
    backend: await fallback.backend,
    read: await fallback.read("notification-previews"),
  });
});

it("a real blocked schema upgrade hides an existing private preference", async () => {
  const held = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("tandem-device", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("values");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = held.transaction("values", "readwrite");
      tx.objectStore("values").put(JSON.stringify({ [account]: "none" }), "notification-previews");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // The old client still holds its database open. No production function is mocked.
    const fallback = deviceStore();
    expect(await fallback.backend).toBe("localstorage");
    expect(await fallback.read("notification-previews")).toBe(null);
    evidence.push({
      case: "actual blocked v1->v2 upgrade",
      olderDatabasePreview: "none",
      backend: await fallback.backend,
      fallbackRead: await fallback.read("notification-previews"),
      productionFunctionMocked: false,
    });
  } finally {
    held.close();
  }
});
