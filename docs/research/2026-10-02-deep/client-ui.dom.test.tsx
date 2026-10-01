import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { URL as NodeURL } from "node:url";
import { transferableAbortController } from "node:util";
import WebSocket from "ws";
import { Profiler } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api, WorkspaceClient } from "@slackoss/client-core";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import { ClientContext, PlatformContext } from "../../../packages/ui/src/context.js";
import {
  ShareableServerProvider,
  useShareableServer,
  useWorkspaceAddresses,
} from "../../../packages/ui/src/components/ShareableServer.js";
import { MessageItem } from "../../../packages/ui/src/components/MessageItem.js";
import { ActivityPanel } from "../../../packages/ui/src/components/ActivityPanel.js";
import { ThreadPanel } from "../../../packages/ui/src/components/ThreadPanel.js";
import { ToastProvider } from "../../../packages/ui/src/components/Toast.js";
import { ConfirmProvider } from "../../../packages/ui/src/components/Confirm.js";
import type { HostingStatus, Platform } from "../../../packages/ui/src/platform.js";

const observations: Record<string, unknown>[] = [];
let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let channelId: string;
let readerId: string;
const releases: (() => void)[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => void (resolve = done));
  return { promise, resolve };
}

function platform(): Platform {
  return { kind: "web", storage: { get: async () => null, set: async () => {} }, notify: () => {} };
}

beforeEach(async () => {
  // ws uses its own wire-event wrappers, avoiding Node EventTarget/jsdom Event
  // cross-realm incompatibility while retaining actual WebSocket transport.
  vi.stubGlobal("WebSocket", WebSocket);
  const nodeAbort = transferableAbortController();
  vi.stubGlobal("AbortController", nodeAbort.constructor);
  vi.stubGlobal("AbortSignal", nodeAbort.signal.constructor);
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const unauthenticated = new Api(baseUrl);
  const account = await unauthenticated.register({
    handle: "owner",
    displayName: "Owner",
    password: "password123",
  });
  const reader = await unauthenticated.register({
    handle: "reader",
    displayName: "Reader",
    password: "password123",
  });
  owner = new Api(baseUrl, account.token);
  readerId = reader.user.id;
  client = new WorkspaceClient(baseUrl, reader.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find(
    (channel) => channel.name === "general",
  )!.id;
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  client?.destroy();
  await server?.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => {
  writeFileSync(
    new NodeURL("client-ui-evidence.json", import.meta.url),
    JSON.stringify(
      {
        sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        runtime: { node: process.version, platform: process.platform },
        scope:
          "Actual UI/client source mounted in jsdom against real in-memory HTTP/WebSocket server; Profiler commit counts, not browser layout/latency.",
        observations,
      },
      null,
      2,
    ) + "\n",
  );
});

describe("production UI/client diagnostics", () => {
  it("connected-count-only bridge updates commit every row beneath the production link provider", async () => {
    for (let i = 0; i < 30; i++) await owner.sendMessage(channelId, { text: `row ${i}` });
    await expect.poll(() => client.state.lastSeq).toBe(server.store.currentSeq());
    await client.loadTimeline(channelId);
    const messages = client.state.timelines[channelId]!.items;
    let latestStatus: HostingStatus = {
      running: true,
      phase: "running",
      port: server.port,
      connected: 1,
      lanUrls: [`192.168.1.20:${server.port}`],
    };
    let bridgeEvent: ((next: HostingStatus) => void) | undefined;
    const adapter: Platform = {
      ...platform(),
      kind: "desktop",
      hosting: {
        status: async () => latestStatus,
        subscribe: (listener) => {
          bridgeEvent = listener;
          return () => void (bridgeEvent = undefined);
        },
        start: async () => latestStatus,
        stop: async () => {},
      },
    };
    let currentLink = "";
    let currentAddresses: ReadonlySet<string> | null = null;
    function LinkObserver() {
      currentLink = useShareableServer().serverUrl;
      currentAddresses = useWorkspaceAddresses();
      return <span data-testid="shared-address">{currentLink}</span>;
    }
    const committed = new Set<string>();
    render(
      <PlatformContext.Provider value={adapter}>
        <ClientContext.Provider value={client}>
          <ToastProvider>
            <ConfirmProvider>
              <ShareableServerProvider platform={adapter}>
                <LinkObserver />
                {messages.map((message) => (
                  <Profiler
                    key={message.id}
                    id={message.id}
                    onRender={(id) => void committed.add(id)}
                  >
                    <MessageItem message={message} compact={false} />
                  </Profiler>
                ))}
              </ShareableServerProvider>
            </ConfirmProvider>
          </ToastProvider>
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    await waitFor(() => expect(currentLink).toBe(`http://192.168.1.20:${server.port}`));
    // Finish bootstrap/read effects before the isolated host-count update.
    await act(async () => {});
    const beforeAddresses = [...currentAddresses!].sort();
    const beforeSet = currentAddresses;
    committed.clear();
    await act(async () => {
      latestStatus = { ...latestStatus, connected: 2 };
      bridgeEvent!(latestStatus);
    });
    expect(committed.size).toBe(30);
    expect([...currentAddresses!].sort()).toEqual(beforeAddresses);
    expect(currentAddresses).not.toBe(beforeSet);
    observations.push({
      name: "link_provider_unrelated_connected_count",
      mountedRows: messages.length,
      committedRows: committed.size,
      addressSetIdentityChanged: currentAddresses !== beforeSet,
      addressEntriesUnchanged:
        JSON.stringify([...currentAddresses!].sort()) === JSON.stringify(beforeAddresses),
      transport: "Real HTTP/socket client; simulated desktop HostingStatus bridge subscription",
      limitation:
        "Profiler observes React commits in jsdom; no packaged Electron IPC, production React timing, browser layout or paint measurement.",
    });
  });

  it("Activity clears its displayed result and sends one fetch per separately delivered equal-count invalidation", async () => {
    await owner.sendMessage(channelId, { text: `Visible activity <@${readerId}>` });
    await expect.poll(() => client.state.lastSeq).toBe(server.store.currentSeq());
    const adapter = platform();
    const originalFetch = globalThis.fetch;
    const gate = deferred<void>();
    releases.push(() => gate.resolve());
    let holding = false;
    const transfers: { signal: AbortSignal | null; delivered: boolean }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      if (!String(args[0]).includes("/api/activity")) return originalFetch(...args);
      const transfer = {
        signal: (args[1]?.signal as AbortSignal | undefined) ?? null,
        delivered: false,
      };
      transfers.push(transfer);
      const response = await originalFetch(...args);
      if (holding) await gate.promise;
      transfer.delivered = true;
      return response;
    });
    render(
      <PlatformContext.Provider value={adapter}>
        <ClientContext.Provider value={client}>
          <ActivityPanel onClose={() => {}} onJump={() => {}} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const panel = screen.getByRole("complementary", { name: "Activity" });
    await within(panel).findByText(/Visible activity/);
    const requestsBefore = transfers.length;
    holding = true;
    let blankObservations = 0;
    const invalidations = 10;
    for (let i = 0; i < invalidations; i++) {
      const count = transfers.length;
      await act(async () =>
        server.gateway.sendToUser(readerId, {
          type: "mentions",
          counts: { [channelId]: 1 },
        }),
      );
      await waitFor(() => expect(transfers.length).toBe(count + 1));
      if (!within(panel).queryByText(/Visible activity/)) blankObservations++;
    }
    const abortedBeforeRelease = transfers
      .slice(requestsBefore)
      .filter(({ signal }) => signal?.aborted).length;
    expect(blankObservations).toBe(invalidations);
    expect(abortedBeforeRelease).toBe(invalidations - 1);
    gate.resolve();
    await within(panel).findByText(/Visible activity/);
    observations.push({
      name: "activity_equal_count_invalidation_burst",
      invalidations,
      resultingRequests: transfers.length - requestsBefore,
      blankObservations,
      abortedBeforeRelease,
      finalAuthoritativeResultVisible: Boolean(within(panel).queryByText(/Visible activity/)),
      transport: "Real gateway frames and HTTP responses; response delivery held after real fetch",
      limitation:
        "Invalidations deliberately spaced across React effect turns; same-turn updates can batch. Network/server work occurs before the delivery gate; no latency or body-waste measurement.",
    });
  });

  it("an unrelated live channel message commits the mounted thread although its content is unchanged", async () => {
    const root = (await owner.sendMessage(channelId, { text: "visible thread root" })).message;
    await owner.sendMessage(channelId, { text: "visible thread reply", threadRootId: root.id });
    await expect.poll(() => client.state.lastSeq).toBe(server.store.currentSeq());
    const adapter = platform();
    let commits = 0;
    render(
      <PlatformContext.Provider value={adapter}>
        <ClientContext.Provider value={client}>
          <ToastProvider>
            <ConfirmProvider>
              <Profiler id="visible-thread" onRender={() => commits++}>
                <ThreadPanel
                  rootId={root.id}
                  channelId={channelId}
                  readActive={false}
                  onClose={() => {}}
                  onChannelClick={() => {}}
                  onOpenProfile={() => {}}
                />
              </Profiler>
            </ConfirmProvider>
          </ToastProvider>
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    await screen.findByText("visible thread reply");
    await act(async () => {});
    const contentBefore = document.body.textContent;
    const before = commits;
    await act(async () => {
      await owner.sendMessage(channelId, { text: "unrelated off-panel top-level" });
      await expect.poll(() => client.state.lastSeq).toBe(server.store.currentSeq());
    });
    expect(commits - before).toBeGreaterThan(0);
    expect(document.body.textContent).toBe(contentBefore);
    observations.push({
      name: "visible_thread_unrelated_live_message",
      additionalCommits: commits - before,
      visibleContentUnchanged: document.body.textContent === contentBefore,
      transport: "Real HTTP send and reader WebSocket into actual ThreadPanel",
      limitation:
        "Read marking disabled to isolate render churn; jsdom does no real scroll geometry or layout.",
    });
  });
});
