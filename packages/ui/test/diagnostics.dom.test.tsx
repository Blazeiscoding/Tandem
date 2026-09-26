import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Message, User } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../src/context.js";
import { DiagnosticsDialog } from "../src/components/DiagnosticsDialog.js";
import { diagnosticsReport } from "../src/lib/diagnostics.js";
import type { Platform } from "../src/platform.js";
import { accessibilityProblems } from "./accessibility.js";

const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  statusText: "Planning the launch",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

afterEach(() => vi.restoreAllMocks());

describe("the diagnostics report", () => {
  const base = {
    app: "web" as const,
    address: "http://10.0.0.5:8543",
    status: "online",
    huddle: null,
    waitingToSend: 2,
    userAgent: "Mozilla/5.0 Test",
    online: true,
    width: 390,
    height: 844,
    pixelRatio: 3,
    notifications: "granted",
    now: new Date("2026-09-26T12:00:00Z"),
  };

  it("says which versions run and how this device is connected", () => {
    const report = diagnosticsReport({
      ...base,
      server: {
        app: "slackoss",
        protocolVersion: 1,
        serverVersion: "0.4.2",
        workspaceName: "Rocket Team",
        userCount: 4,
        requiresInvite: true,
        requiresClaim: false,
      },
    });
    expect(report.split("\n")).toEqual([
      "Gatherline diagnostics",
      "Taken: 2026-09-26T12:00:00.000Z",
      "App: browser, protocol 1",
      "Server: v0.4.2, protocol 1",
      "Address: http://10.0.0.5:8543",
      "Connection: online",
      "Waiting to send: 2",
      "Huddle: not in a call",
      "Notifications: granted",
      "Window: 390×844 at 3×",
      "Browser: Mozilla/5.0 Test",
    ]);
    // Not even the workspace's name, which the server's answer carries.
    expect(report).not.toContain("Rocket Team");
  });

  it("says when the server could not be reached, and when this device is offline", () => {
    const report = diagnosticsReport({
      ...base,
      online: false,
      status: "reconnecting",
      server: { error: "timed out" },
    });
    expect(report).toContain("Server: not reachable (timed out)");
    expect(report).toContain("Connection: reconnecting (this device is offline)");
  });
});

describe("the diagnostics dialog", () => {
  it("shows the whole report before copying exactly that, and nothing anyone wrote", async () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    const secret: Message = {
      id: "M_SECRET",
      channelId: "C_GENERAL",
      userId: sam.id,
      text: "The launch moves to Friday",
      seq: 1,
      createdAt: 0,
    } as Message;
    client.store.setState({
      self: sam,
      users: { [sam.id]: sam },
      status: "online",
      workspaceName: "Rocket Team",
      drafts: { C_GENERAL: "Do not tell anyone yet" },
      timelines: {
        C_GENERAL: { items: [secret], loaded: true, hasMore: false, hasMoreNewer: false },
      } as never,
    });
    vi.spyOn(client.api, "serverInfo").mockResolvedValue({
      app: "slackoss",
      protocolVersion: 1,
      serverVersion: "0.4.2",
      workspaceName: "Rocket Team",
      userCount: 4,
      requiresInvite: true,
      requiresClaim: false,
    });
    const platform: Platform = {
      kind: "web",
      storage: { get: async () => null, set: async () => {} },
      notify: () => {},
    };
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <DiagnosticsDialog onClose={() => {}} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const user = userEvent.setup();
    const dialog = screen.getByRole("dialog", { name: "Diagnostics" });
    expect(within(dialog).getByRole("button", { name: "Copy diagnostics" })).toBeDisabled();
    const report = await within(dialog).findByLabelText("Diagnostics report");
    expect(report).toHaveTextContent("Server: v0.4.2, protocol 1");
    for (const private_ of [
      "The launch moves to Friday",
      "Do not tell anyone yet",
      "Sam Rivera",
      "Planning the launch",
      "Rocket Team",
    ]) {
      expect(report).not.toHaveTextContent(private_);
    }
    expect(await accessibilityProblems(dialog)).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Copy diagnostics" }));
    expect(await navigator.clipboard.readText()).toBe(report.textContent);
    expect(within(dialog).getByRole("button", { name: "Copied" })).toBeVisible();
  });
});
