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

/** One device's storage, kept across the clients a test starts on it. */
function device() {
  const values = new Map<string, unknown>();
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
});
