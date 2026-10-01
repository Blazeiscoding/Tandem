import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { Message, ServerInfo, User, WorkspaceStatus } from "@slackoss/protocol";
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

describe("the server's status in the report, for the owner and admins (OPS-10)", () => {
  const base = {
    app: "web" as const,
    address: "http://10.0.0.5:8543",
    status: "online",
    huddle: null,
    waitingToSend: 0,
    userAgent: "Mozilla/5.0 Test",
    online: true,
    width: 390,
    height: 844,
    pixelRatio: 3,
    notifications: "granted",
    server: { error: "timed out" },
    now: new Date("2026-09-26T12:00:00Z"),
  };
  const busy: WorkspaceStatus = {
    serverVersion: "0.4.2",
    schemaVersion: 34,
    uptimeSeconds: 3 * 3600 + 5 * 60,
    database: { bytes: 48 * 1024 * 1024, walBytes: 4 * 1024 * 1024 },
    attachments: { bytes: 300 * 1024 * 1024, limitBytes: 1024 ** 3 },
    diskFreeBytes: 12 * 1024 ** 3,
    deliveries: {
      waiting: 3,
      oldestWaitingAt: Date.parse("2026-09-26T11:48:00Z"),
      failed: 1,
    },
    scheduled: { queued: 2, held: 1, failed: 0 },
    retention: {
      enabled: true,
      lastSuccessAt: Date.parse("2026-09-26T03:00:00Z"),
      failures: 2,
    },
    connections: { sockets: 5, people: 1 },
    eventLoopDelayMs: { p50: 10.2, p99: 12.5, max: 40.1 },
  };

  it("adds sizes, queues and timings after the device's own lines", () => {
    const lines = diagnosticsReport({ ...base, workspace: busy }).split("\n");
    expect(lines.slice(lines.indexOf("Workspace status"))).toEqual([
      "Workspace status",
      "Server: v0.4.2, schema 34, up 3 h 5 min",
      "Database: 48 MB, log 4.0 MB",
      "Attachments: 300 MB of 1.0 GB",
      "Free disk: 12 GB",
      "App deliveries: 3 waiting (oldest for 12 min), 1 given up",
      "Scheduled messages: 2 queued, 1 held for a retry, 0 failed",
      "History removal: last done 2026-09-26T03:00:00.000Z, 2 failures since",
      "Connections: 5 sockets for 1 person",
      "Event loop delay: p50 10.2 ms, p99 12.5 ms, max 40.1 ms",
    ]);
  });

  it("says what is off, unknown or not measured yet, rather than leaving it out", () => {
    const report = diagnosticsReport({
      ...base,
      workspace: {
        ...busy,
        uptimeSeconds: 20,
        attachments: { bytes: 0, limitBytes: null },
        diskFreeBytes: null,
        deliveries: { waiting: 0, oldestWaitingAt: null, failed: 0 },
        retention: { enabled: false, lastSuccessAt: null, failures: 0 },
        eventLoopDelayMs: null,
      },
    });
    expect(report).toContain("Server: v0.4.2, schema 34, up 20 s");
    expect(report).toContain("Attachments: 0 B, no limit");
    expect(report).toContain("Free disk: unknown");
    expect(report).toContain("App deliveries: 0 waiting, 0 given up");
    expect(report).toContain("History removal: off");
    expect(report).toContain("Event loop delay: not measured until the server has run a minute");
  });

  it("says when the status could not be read", () => {
    const report = diagnosticsReport({ ...base, workspace: { error: "timed out" } });
    expect(report.split("\n").slice(-2)).toEqual(["Workspace status", "Not available: timed out"]);
  });

  it("is not in a report without it", () => {
    expect(diagnosticsReport(base)).not.toContain("Workspace status");
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

  const info: ServerInfo = {
    app: "slackoss",
    protocolVersion: 1,
    serverVersion: "0.4.2",
    workspaceName: "Rocket Team",
    userCount: 4,
    requiresInvite: true,
    requiresClaim: false,
  };

  function open(self: User, answer: () => Promise<WorkspaceStatus> = () => new Promise(() => {})) {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({ self, users: { [self.id]: self }, status: "online" });
    vi.spyOn(client.api, "serverInfo").mockResolvedValue(info);
    const status = vi.spyOn(client.api, "workspaceStatus").mockImplementation(answer);
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
    return { status };
  }

  it("adds the server's status for an admin", async () => {
    open({ ...sam, role: "admin" }, async () => ({
      serverVersion: "0.4.2",
      schemaVersion: 34,
      uptimeSeconds: 90,
      database: { bytes: 2048, walBytes: 0 },
      attachments: { bytes: 0, limitBytes: null },
      diskFreeBytes: null,
      deliveries: { waiting: 0, oldestWaitingAt: null, failed: 0 },
      scheduled: { queued: 0, held: 0, failed: 0 },
      retention: { enabled: false, lastSuccessAt: null, failures: 0 },
      connections: { sockets: 1, people: 1 },
      eventLoopDelayMs: null,
    }));
    const report = await screen.findByLabelText("Diagnostics report");
    expect(report).toHaveTextContent("Workspace status");
    expect(report).toHaveTextContent("Server: v0.4.2, schema 34, up 1 min");
    expect(screen.getByText(/how the server is keeping up/)).toBeVisible();
  });

  it("says a server too old to report its status is too old, for the owner", async () => {
    open({ ...sam, role: "owner" }, () => Promise.reject(new ApiError(404, "not_found")));
    expect(await screen.findByLabelText("Diagnostics report")).toHaveTextContent(
      "Not available: this server's version does not report it",
    );
  });

  it("never asks for it for a member", async () => {
    const { status } = open(sam);
    expect(await screen.findByLabelText("Diagnostics report")).not.toHaveTextContent(
      "Workspace status",
    );
    expect(status).not.toHaveBeenCalled();
    expect(screen.queryByText(/how the server is keeping up/)).toBeNull();
  });
});
