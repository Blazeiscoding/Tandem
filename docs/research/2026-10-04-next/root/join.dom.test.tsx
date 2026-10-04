import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Api } from "@slackoss/client-core";
import { PROTOCOL_VERSION, type ServerInfo } from "@slackoss/protocol";
import { JoinScreen } from "../../../../packages/ui/src/screens/JoinScreen.js";
import type { Platform, SavedServer } from "../../../../packages/ui/src/platform.js";

const evidence: Record<string, unknown> = {};
const saved: SavedServer = {
  url: "http://127.0.0.1:9",
  token: "synthetic-saved-token",
  workspaceName: "Saved A",
  handle: "sam",
  lastUsedAt: 1,
};
const platform: Platform = {
  kind: "desktop",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};
const info: ServerInfo = {
  app: "slackoss",
  protocolVersion: PROTOCOL_VERSION,
  serverVersion: "0.1.0",
  workspaceName: "New B",
  userCount: 2,
  requiresInvite: false,
  requiresClaim: false,
};
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());
afterAll(() =>
  writeFileSync(
    resolve(
      process.env.TANDEM_RESEARCH_ROOT!,
      "docs/research/2026-10-04-next/root/join-evidence.json",
    ),
    JSON.stringify(evidence, null, 2) + "\n",
  ),
);

describe("diagnostic assertions for sign-in cancellation", () => {
  it("a cancelled saved sign-in completes and navigates after a different workspace is selected", async () => {
    const me = held<Awaited<ReturnType<Api["me"]>>>();
    vi.spyOn(Api.prototype, "me").mockReturnValue(me.promise);
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    const connected = vi.fn();
    render(
      <JoinScreen
        platform={platform}
        savedServers={[saved]}
        onConnected={connected}
        onForget={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Saved A/ }));
    await waitFor(() => expect(Api.prototype.me).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Server address" }), {
      target: { value: "http://127.0.0.1:10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
    await screen.findByRole("heading", { name: "New B" });
    expect(connected).not.toHaveBeenCalled();
    await act(async () =>
      me.resolve({ user: { id: "U1", handle: "sam" } } as Awaited<ReturnType<Api["me"]>>),
    );
    expect(connected).toHaveBeenCalledWith(saved);
    evidence.cancelledSavedSignIn = {
      cancelled: true,
      chosenAfterCancel: "New B",
      lateConnected: connected.mock.calls[0]![0].workspaceName,
    };
  });

  it("cancelling an ordinary address probe ignores its late success", async () => {
    const reply = held<ServerInfo>();
    vi.spyOn(Api.prototype, "serverInfo").mockReturnValue(reply.promise);
    const connected = vi.fn();
    render(
      <JoinScreen
        platform={platform}
        savedServers={[saved]}
        onConnected={connected}
        onForget={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Server address" }), {
      target: { value: "http://127.0.0.1:10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
    await waitFor(() => expect(Api.prototype.serverInfo).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => reply.resolve(info));
    expect(screen.queryByRole("heading", { name: "New B" })).toBeNull();
    expect(connected).not.toHaveBeenCalled();
    evidence.probeCancelControl = { lateAuthCard: false, connected: false };
  });

  it("an abandoned password submission still reports a connected session after its form unmounts", async () => {
    const login = held<Awaited<ReturnType<Api["login"]>>>();
    vi.spyOn(Api.prototype, "serverInfo").mockResolvedValue(info);
    vi.spyOn(Api.prototype, "login").mockReturnValue(login.promise);
    const connected = vi.fn();
    render(
      <JoinScreen
        platform={platform}
        savedServers={[saved]}
        onConnected={connected}
        onForget={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Server address" }), {
      target: { value: "http://127.0.0.1:10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
    await screen.findByRole("heading", { name: "New B" });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "sam" } });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "synthetic-password" },
    });
    const tabPanel = screen.getByRole("tabpanel", { name: "Sign in" });
    fireEvent.click(within(tabPanel).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(Api.prototype.login).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "All workspaces" }));
    expect(screen.queryByRole("heading", { name: "New B" })).toBeNull();
    await act(async () =>
      login.resolve({ token: "synthetic-new-token", user: { id: "U1", handle: "sam" } } as Awaited<
        ReturnType<Api["login"]>
      >),
    );
    expect(connected).toHaveBeenCalledOnce();
    evidence.abandonedAuth = {
      formRemoved: true,
      lateConnected: connected.mock.calls[0]![0].workspaceName,
    };
  });
});
