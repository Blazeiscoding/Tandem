import { transferableAbortController } from "node:util";
import WebSocket from "ws";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Api, WorkspaceClient } from "@slackoss/client-core";
import { createWorkspaceServer, type WorkspaceServer } from "@slackoss/server";
import type { Channel } from "@slackoss/protocol";
import { ClientContext, PlatformContext } from "../../../../packages/ui/src/context.js";
import type { Platform } from "../../../../packages/ui/src/platform.js";
import { SearchDialog } from "../../../../packages/ui/src/components/SearchDialog.js";
import { PinsPanel } from "../../../../packages/ui/src/components/MessageListPanel.js";
import { ProfileDialog } from "../../../../packages/ui/src/components/ProfileDialog.js";
import { NewDmDialog } from "../../../../packages/ui/src/components/dialogs.js";
import { WorkspaceScreen } from "../../../../packages/ui/src/screens/WorkspaceScreen.js";
import { ConfirmProvider } from "../../../../packages/ui/src/components/Confirm.js";
import { ToastProvider } from "../../../../packages/ui/src/components/Toast.js";

let server: WorkspaceServer;
let client: WorkspaceClient;
let owner: Api;
let channelId: string;
const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}
function wrap(child: React.ReactNode) {
  return (
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <ToastProvider>
          <ConfirmProvider>{child}</ConfirmProvider>
        </ToastProvider>
      </ClientContext.Provider>
    </PlatformContext.Provider>
  );
}

beforeEach(async () => {
  vi.stubGlobal("WebSocket", WebSocket);
  const abort = transferableAbortController();
  vi.stubGlobal("AbortController", abort.constructor);
  vi.stubGlobal("AbortSignal", abort.signal.constructor);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: !query.includes("max-width"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  server = await createWorkspaceServer({
    dataDir: ":memory:",
    host: "127.0.0.1",
    port: 0,
    mdns: false,
    rateLimits: false,
    retentionDays: 1,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const account = await new Api(base).register({
    handle: "researchowner",
    displayName: "Research Owner",
    password: "password123",
  });
  owner = new Api(base, account.token);
  client = new WorkspaceClient(base, account.token);
  client.connect();
  await expect.poll(() => client.state.status).toBe("online");
  channelId = Object.values(client.state.channels).find(
    (channel) => channel.name === "general",
  )!.id;
});
afterEach(async () => {
  cleanup();
  client?.destroy();
  await server?.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("new authoritative result invalidation diagnostics", () => {
  it.each(["delete", "retention"])(
    "an open search retains removed text after real %s",
    async (mode) => {
      const phrase = "searchable syntheticRemovedPhrase";
      const { message } = await owner.sendMessage(channelId, { text: phrase });
      await expect.poll(() => client.state.lastSeq).toBeGreaterThanOrEqual(message.seq);
      render(wrap(<SearchDialog onClose={() => {}} onJump={() => {}} />));
      const user = userEvent.setup();
      await user.type(screen.getByRole("textbox", { name: "Search messages" }), "searchable");
      await user.click(screen.getByRole("button", { name: "Search", exact: true }));
      expect(await screen.findByText(/syntheticRemovedPhrase/)).toBeVisible();
      const before = client.state.lastSeq;
      await act(async () => {
        if (mode === "delete") await owner.deleteMessage(message.id);
        else {
          const db = (server.store as unknown as { db: { exec(sql: string): void } }).db;
          db.exec("UPDATE messages SET created_at = created_at - 172800000");
          expect(server.applyRetention()).toBe(1);
        }
        await expect.poll(() => client.state.lastSeq).toBeGreaterThan(before);
      });
      if (mode === "retention")
        expect(client.state.removedHistory[channelId]).toBeGreaterThan(before);
      expect((await client.api.search("searchable")).messages).toHaveLength(0);
      expect(screen.getByText(/syntheticRemovedPhrase/)).toBeVisible();
      // Explicitly repeating the same search removes the stale content.
      await user.click(screen.getByRole("button", { name: "Search", exact: true }));
      expect(await screen.findByText("Nothing matched. Try different words.")).toBeVisible();
      expect(screen.queryByText(/syntheticRemovedPhrase/)).toBeNull();
    },
  );

  it("an open search retains old text after a real edit until the reader searches again", async () => {
    const { message } = await owner.sendMessage(channelId, {
      text: "searchable syntheticOldPhrase",
    });
    render(wrap(<SearchDialog onClose={() => {}} onJump={() => {}} />));
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Search messages" }), "searchable");
    await user.click(screen.getByRole("button", { name: "Search", exact: true }));
    expect(await screen.findByText(/syntheticOldPhrase/)).toBeVisible();
    const before = client.state.lastSeq;
    await act(async () => {
      await owner.editMessage(message.id, "searchable syntheticNewPhrase");
      await expect.poll(() => client.state.lastSeq).toBeGreaterThan(before);
    });
    expect((await client.api.search("searchable")).messages[0]!.text).toContain(
      "syntheticNewPhrase",
    );
    expect(screen.getByText(/syntheticOldPhrase/)).toBeVisible();
    expect(screen.queryByText(/syntheticNewPhrase/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Search", exact: true }));
    expect(await screen.findByText(/syntheticNewPhrase/)).toBeVisible();
  });

  it.each([false, true])(
    "pins after real deletion with timeline loaded=%s",
    async (loadHistory) => {
      const { message } = await owner.sendMessage(channelId, { text: "syntheticPinnedPhrase" });
      await owner.pinMessage(message.id);
      if (loadHistory) await client.loadTimeline(channelId);
      render(wrap(<PinsPanel channelId={channelId} onClose={() => {}} onJump={() => {}} />));
      expect(await screen.findByText("syntheticPinnedPhrase")).toBeVisible();
      const before = client.state.lastSeq;
      await act(async () => {
        await owner.deleteMessage(message.id);
        await expect.poll(() => client.state.lastSeq).toBeGreaterThan(before);
      });
      expect((await client.api.listPins(channelId)).messages).toHaveLength(0);
      if (loadHistory)
        await waitFor(() => expect(screen.queryByText("syntheticPinnedPhrase")).toBeNull());
      else {
        expect(screen.getByText("syntheticPinnedPhrase")).toBeVisible();
        await userEvent.setup().click(screen.getByRole("button", { name: "Refresh" }));
        await waitFor(() => expect(screen.queryByText("syntheticPinnedPhrase")).toBeNull());
      }
    },
  );
});

describe("new dismissed-action ownership diagnostics", () => {
  it("a dismissed Profile still invokes its navigation callback, while New message does not", async () => {
    const other = await new Api(client.baseUrl).register({
      handle: "othermember",
      displayName: "Other Member",
      password: "password123",
    });
    await expect.poll(() => client.state.users[other.user.id]?.id).toBe(other.user.id);
    const dm: Channel = {
      id: "D_SYNTHETIC",
      type: "dm",
      name: "",
      topic: "",
      description: "",
      creatorId: client.state.self!.id,
      archived: false,
      createdAt: 0,
      memberIds: [client.state.self!.id, other.user.id],
    };
    const old = deferred<Channel>();
    const opening = vi.spyOn(client, "openDm").mockReturnValueOnce(old.promise);
    const navigation = vi.fn();
    const profile = render(
      wrap(<ProfileDialog userId={other.user.id} onClose={() => {}} onOpenDm={navigation} />),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Message Other Member" }));
    profile.unmount();
    await act(async () => old.resolve(dm));
    expect(navigation).toHaveBeenCalledWith(dm.id);
    navigation.mockClear();

    const later = deferred<Channel>();
    opening.mockReturnValueOnce(later.promise);
    const fresh = render(
      wrap(
        <NewDmDialog initialMemberIds={[other.user.id]} onClose={() => {}} onOpen={navigation} />,
      ),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Start conversation" }));
    fresh.unmount();
    await act(async () => later.resolve(dm));
    expect(navigation).not.toHaveBeenCalled();
  });

  it("a dismissed real Profile request reopens the old DM after navigating elsewhere in WorkspaceScreen", async () => {
    const other = await new Api(client.baseUrl).register({
      handle: "othermember",
      displayName: "Other Member",
      password: "password123",
    });
    const apiOther = new Api(client.baseUrl, other.token);
    await apiOther.sendMessage(channelId, { text: "Hello from the other member" });
    await owner.createChannel({ type: "public", name: "design" });
    await expect
      .poll(() => Object.values(client.state.channels).some((channel) => channel.name === "design"))
      .toBe(true);
    const gate = deferred<void>();
    const original = client.api.createChannel.bind(client.api);
    const creating = vi.spyOn(client.api, "createChannel").mockImplementation(async (body) => {
      if (body.type === "dm") await gate.promise;
      return original(body);
    });
    render(
      wrap(
        <WorkspaceScreen
          client={client}
          platform={platform}
          onLeaveWorkspace={() => {}}
          onSignedOut={() => {}}
        />,
      ),
    );
    const user = userEvent.setup();
    const authors = await screen.findAllByRole("button", { name: "View Other Member's profile" });
    await user.click(authors[0]!);
    await user.click(await screen.findByRole("button", { name: "Message Other Member" }));
    expect(creating).toHaveBeenCalledTimes(1);
    await user.click(
      within(screen.getByRole("dialog", { name: "Profile" })).getByRole("button", {
        name: "Close",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Profile" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "# design" }));
    expect(screen.getByRole("textbox", { name: "Message #design" })).toBeVisible();
    await act(async () => {
      gate.resolve();
      await creating.mock.results[0]!.value;
    });
    expect(await screen.findByRole("textbox", { name: "Message Other Member" })).toBeVisible();
  });
});
