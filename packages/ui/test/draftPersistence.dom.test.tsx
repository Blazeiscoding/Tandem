import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, OUTBOX_LIMIT, WorkspaceClient } from "@slackoss/client-core";
import type { Channel, Message, User } from "@slackoss/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftPersistence } from "../src/components/DraftPersistence.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";

/**
 * Unsent work on this device, through the storage it is written to: a restart
 * brings back every queued send, a refused one stays refused, and a write that
 * fails is said out loud.
 */
const sam: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
};

const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id],
};

/**
 * One device's storage, kept across the clients a test starts on it. Passing
 * another device's values gives a second window onto the same storage.
 */
function device(values = new Map<string, unknown>()) {
  const platform: Platform = {
    kind: "desktop",
    storage: {
      get: async <T,>(name: string) => (values.get(name) ?? null) as T | null,
      set: async (name: string, value: unknown) => void values.set(name, value),
    },
    notify: () => {},
  };
  return { platform, values };
}

/** A signed-in client whose sends go nowhere until the test says otherwise. */
function signedIn() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [design.id]: design },
    status: "online",
  });
  const sendMessage = vi.spyOn(client.api, "sendMessage");
  return { client, sendMessage };
}

function mount(client: WorkspaceClient, platform: Platform) {
  return render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <DraftPersistence platform={platform} />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
}

/** The texts in the stored outbox, in order. */
function storedTexts(values: Map<string, unknown>, key: string) {
  return ((values.get(key) ?? []) as Pick<Message, "text">[]).map((e) => e.text);
}

/**
 * Lets queued promise work finish: far less than the pause drafts wait for
 * before they are written, so anything stored by now was written at once.
 */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** What the server answers a send with, once it has the message. */
function sent(client: WorkspaceClient, nonce: string, text: string): Message {
  return {
    id: `M_${nonce}`,
    channelId: design.id,
    userId: client.state.self!.id,
    text,
    threadRootId: null,
    broadcast: false,
    seq: 1,
    createdAt: 0,
    editedAt: null,
    nonce,
    replyCount: 0,
    reactions: [],
    files: [],
    pinned: false,
    actions: [],
  };
}

afterEach(() => vi.restoreAllMocks());

describe("queued messages kept on this device", () => {
  it("come back after a restart, every one, with a refusal still waiting for Retry", async () => {
    const { platform, values } = device();
    const first = signedIn();
    first.sendMessage.mockImplementation(async (_channel, body) => {
      if (body.text === "while archived") throw new ApiError(400, "channel_archived");
      throw new TypeError("Failed to fetch");
    });
    const view = mount(first.client, platform);
    await waitFor(() => expect(values.has(`outbox:${first.client.baseUrl}:${sam.id}`)).toBe(true));

    first.client.send(design.id, "while archived");
    for (let i = 1; i < OUTBOX_LIMIT; i++) first.client.send(design.id, `queued ${i}`);
    await waitFor(() =>
      expect(first.client.state.pending.filter((p) => p.failed)).toHaveLength(OUTBOX_LIMIT),
    );
    // Closing the app writes what is waiting.
    view.unmount();
    first.client.destroy();

    const second = signedIn();
    const delivered: string[] = [];
    second.sendMessage.mockImplementation(async (_channel, body) => {
      delivered.push(body.text!);
      throw new TypeError("Failed to fetch");
    });
    mount(second.client, platform);
    await waitFor(() => expect(second.client.state.pending).toHaveLength(OUTBOX_LIMIT));
    const refused = second.client.state.pending.find((p) => p.text === "while archived")!;
    expect(refused).toMatchObject({
      failed: true,
      failureReason: "This conversation is archived.",
    });
    await waitFor(() => expect(delivered).toHaveLength(OUTBOX_LIMIT - 1));
    expect(delivered).not.toContain("while archived");
  });

  it("says when they could not be written, and writes them on Retry", async () => {
    const { platform, values } = device();
    const { client, sendMessage } = signedIn();
    sendMessage.mockRejectedValue(new TypeError("Failed to fetch"));
    const write = platform.storage.set;
    let broken = false;
    platform.storage.set = async (name, value) => {
      if (broken) throw new Error("QuotaExceededError");
      return write(name, value);
    };
    mount(client, platform);
    const key = `outbox:${client.baseUrl}:${sam.id}`;
    await waitFor(() => expect(values.has(key)).toBe(true));

    broken = true;
    client.send(design.id, "kept in memory for now");
    expect(
      await screen.findByText(
        "Could not save drafts and queued messages on this device. Keep it open and retry.",
      ),
    ).toBeVisible();

    broken = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect((values.get(key) as { text: string }[]).map((e) => e.text)).toEqual([
        "kept in memory for now",
      ]),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("are written when the page is hidden, without waiting for the pause", async () => {
    const { platform, values } = device();
    const { client, sendMessage } = signedIn();
    sendMessage.mockRejectedValue(new TypeError("Failed to fetch"));
    mount(client, platform);
    const key = `outbox:${client.baseUrl}:${sam.id}`;
    await waitFor(() => expect(values.has(key)).toBe(true));

    client.send(design.id, "tab closing");
    act(() => void window.dispatchEvent(new Event("pagehide")));
    await waitFor(() =>
      expect((values.get(key) as Pick<Message, "text">[]).map((e) => e.text)).toEqual([
        "tab closing",
      ]),
    );
  });

  it("are written as soon as a send is accepted, and as soon as it is delivered", async () => {
    const { platform, values } = device();
    const { client, sendMessage } = signedIn();
    let deliver = () => {};
    sendMessage.mockImplementation(
      (_channel, body) =>
        new Promise((resolve) => {
          deliver = () => resolve({ message: sent(client, body.nonce!, body.text!) });
        }),
    );
    mount(client, platform);
    const key = `outbox:${client.baseUrl}:${sam.id}`;
    await waitFor(() => expect(values.has(key)).toBe(true));

    expect(client.send(design.id, "on its way")).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    // Closing the app now must not lose it, and nothing waits for a pause in typing.
    await settle();
    expect(storedTexts(values, key)).toEqual(["on its way"]);

    await act(async () => deliver());
    expect(client.state.pending).toEqual([]);
    await settle();
    expect(storedTexts(values, key)).toEqual([]);
  });

  it("keep a refusal as soon as the server gives it, so a restart does not send it again", async () => {
    const { platform, values } = device();
    const { client, sendMessage } = signedIn();
    let refuse = () => {};
    sendMessage.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          refuse = () => reject(new ApiError(400, "channel_archived"));
        }),
    );
    mount(client, platform);
    const key = `outbox:${client.baseUrl}:${sam.id}`;
    await waitFor(() => expect(values.has(key)).toBe(true));
    client.send(design.id, "into an archived channel");
    await waitFor(() => expect(storedTexts(values, key)).toEqual(["into an archived channel"]), {
      timeout: 1500,
    });

    await act(async () => refuse());
    expect(client.state.pending[0]).toMatchObject({ failed: true, refused: true });
    await settle();
    expect((values.get(key) as { refusal?: string }[])[0]?.refusal).toBe(
      "This conversation is archived.",
    );
  });

  it("keep the sends of every window open on the account, not only the last to write", async () => {
    const { platform, values } = device();
    // A second window on the same storage, with its own client and its own writes.
    const other = device(values);
    const first = signedIn();
    const second = signedIn();
    first.sendMessage.mockRejectedValue(new TypeError("Failed to fetch"));
    second.sendMessage.mockRejectedValue(new TypeError("Failed to fetch"));
    mount(first.client, platform);
    mount(second.client, other.platform);
    const key = `outbox:${first.client.baseUrl}:${sam.id}`;
    await waitFor(() => expect(values.has(key)).toBe(true));

    first.client.send(design.id, "from the first window");
    await waitFor(() => expect(storedTexts(values, key)).toEqual(["from the first window"]), {
      timeout: 1500,
    });
    second.client.send(design.id, "from the second window");
    await waitFor(() => expect(storedTexts(values, key)).toContain("from the second window"), {
      timeout: 1500,
    });
    expect(storedTexts(values, key)).toEqual(["from the first window", "from the second window"]);

    // Both windows die without writing again; the next start sends both.
    const next = signedIn();
    const delivered: string[] = [];
    next.sendMessage.mockImplementation(async (_channel, body) => {
      delivered.push(body.text!);
      throw new TypeError("Failed to fetch");
    });
    mount(next.client, device(values).platform);
    await waitFor(() =>
      expect(delivered.sort()).toEqual(["from the first window", "from the second window"]),
    );
  });

  it("restore an outbox saved before this version, and keep it once another send is written", async () => {
    const { platform, values } = device();
    const { client, sendMessage } = signedIn();
    const key = `outbox:${client.baseUrl}:${sam.id}`;
    values.set(key, [
      {
        nonce: "saved-before-upgrade",
        channelId: design.id,
        threadRootId: null,
        text: "queued by the previous version",
        userId: sam.id,
        createdAt: 1,
        attachments: [],
      },
    ]);
    const delivered: string[] = [];
    sendMessage.mockImplementation(async (_channel, body) => {
      delivered.push(body.text!);
      throw new TypeError("Failed to fetch");
    });
    mount(client, platform);
    await waitFor(() => expect(delivered).toEqual(["queued by the previous version"]));
    expect(sendMessage.mock.calls[0]![1].nonce).toBe("saved-before-upgrade");

    client.send(design.id, "queued by this one");
    await waitFor(() =>
      expect(storedTexts(values, key)).toEqual([
        "queued by the previous version",
        "queued by this one",
      ]),
    );
  });
});
