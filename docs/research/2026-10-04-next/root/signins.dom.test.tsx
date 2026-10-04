import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClient } from "@slackoss/client-core";
import { App } from "../../../../packages/ui/src/App.js";
import { webPlatform, type SavedServer } from "../../../../packages/ui/src/platform.js";

// Replace only the large workspace presentation with controls for its public
// callbacks. Production App, JoinScreen and real transactional storage remain.
vi.mock("../../../../packages/ui/src/screens/WorkspaceScreen.js", () => ({
  WorkspaceScreen: ({
    onLeaveWorkspace,
    onOpenWorkspace,
  }: {
    onLeaveWorkspace: () => void;
    onOpenWorkspace: (url: string) => void;
  }) => (
    <div>
      <button onClick={onLeaveWorkspace}>Leave current workspace</button>
      <button onClick={() => onOpenWorkspace("http://127.0.0.1:10")}>Open second workspace</button>
    </div>
  ),
}));
const first: SavedServer = {
  url: "http://127.0.0.1:9",
  token: "synthetic-first-token",
  workspaceName: "Saved A",
  handle: "sam",
  lastUsedAt: 2,
};
const second: SavedServer = {
  url: "http://127.0.0.1:10",
  token: "synthetic-second-token",
  workspaceName: "Saved B",
  handle: "sam",
  lastUsedAt: 1,
};
const evidence: Record<string, unknown> = {};
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", undefined);
  localStorage.clear();
  vi.spyOn(WorkspaceClient.prototype, "connect").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() =>
  writeFileSync(
    resolve(
      process.env.TANDEM_RESEARCH_ROOT!,
      "docs/research/2026-10-04-next/root/signins-evidence.json",
    ),
    JSON.stringify(evidence, null, 2) + "\n",
  ),
);

describe("diagnostic assertions for saved sign-ins in separate windows", () => {
  it("a stale window puts back a sign-in explicitly forgotten in the other window", async () => {
    const a = webPlatform();
    const b = webPlatform();
    await a.storage.set("servers", [first, second]);
    const windowA = render(<App platform={a} />);
    const windowB = render(<App platform={b} />);
    await waitFor(() => expect(WorkspaceClient.prototype.connect).toHaveBeenCalledTimes(2));
    const one = within(windowA.container);
    const two = within(windowB.container);
    fireEvent.click(one.getByRole("button", { name: "Leave current workspace" }));
    const forgotten = await one.findAllByRole("button", { name: "Forget this workspace" });
    fireEvent.click(forgotten[0]!);
    await waitFor(async () =>
      expect(
        (await a.storage.get<SavedServer[]>("servers", { strict: true }))!.map(
          (server) => server.url,
        ),
      ).toEqual([second.url]),
    );
    // The forget operation really committed before B makes an unrelated change.
    fireEvent.click(two.getByRole("button", { name: "Open second workspace" }));
    await waitFor(async () =>
      expect(
        (await b.storage.get<SavedServer[]>("servers", { strict: true }))!.map(
          (server) => server.url,
        ),
      ).toEqual([second.url, first.url]),
    );
    const stored = await a.storage.get<SavedServer[]>("servers", { strict: true });
    expect(stored!.find((server) => server.url === first.url)!.token).toBe(first.token);
    evidence.forgottenSignInReturns = {
      afterAcknowledgedForget: [second.url],
      afterOtherWindowSwitch: stored!.map((server) => server.url),
      forgottenTokenRestored: true,
    };
    windowA.unmount();
    windowB.unmount();
  });

  it("a later first-window save erases a second window's newly acknowledged sign-in", async () => {
    const a = webPlatform();
    const b = webPlatform();
    await a.storage.set("servers", [first, second]);
    const mounted = render(<App platform={a} />);
    await waitFor(() => expect(WorkspaceClient.prototype.connect).toHaveBeenCalledOnce());
    // A successful new sign-in in another window is stored through the same
    // real adapter; A still has its initial in-memory list.
    const third = {
      ...second,
      url: "http://127.0.0.1:11",
      token: "synthetic-third-token",
      workspaceName: "New C",
    };
    await b.storage.set("servers", [third, first, second]);
    expect(
      (await b.storage.get<SavedServer[]>("servers", { strict: true }))!.map(
        (server) => server.url,
      ),
    ).toContain(third.url);
    await act(async () => window.dispatchEvent(new Event("focus")));
    fireEvent.click(
      within(mounted.container).getByRole("button", { name: "Open second workspace" }),
    );
    await waitFor(async () =>
      expect(
        (await a.storage.get<SavedServer[]>("servers", { strict: true }))!.map(
          (server) => server.url,
        ),
      ).toEqual([second.url, first.url]),
    );
    evidence.newSignInLost = {
      otherWindowSaved: third.url,
      afterFirstWindowSwitch: [second.url, first.url],
    };
    mounted.unmount();
  });
});
