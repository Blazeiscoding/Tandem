import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, Message, User } from "@slackoss/protocol";
import { App } from "../src/App.js";
import type { SavedServer } from "../src/platform.js";

const rocket: SavedServer = {
  url: "http://127.0.0.1:9",
  token: "test-token-not-a-credential",
  workspaceName: "Rocket Team",
  handle: "sam",
  lastUsedAt: 1,
};
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
const alex: User = { ...sam, id: "U_ALEX", handle: "alex", displayName: "Alex Chen" };
const general: Channel = {
  id: "C_GENERAL",
  type: "public",
  name: "general",
  topic: "",
  description: "",
  creatorId: alex.id,
  archived: false,
  createdAt: 0,
};

const mention = (over: Partial<Message> = {}): Message => ({
  id: "M_NEW",
  channelId: general.id,
  userId: alex.id,
  text: `<@${sam.id}> can you look at this?`,
  threadRootId: null,
  broadcast: false,
  seq: 5,
  createdAt: 0,
  editedAt: null,
  nonce: null,
  replyCount: 0,
  reactions: [],
  files: [],
  pinned: false,
  actions: [],
  ...over,
});

/** The workspace screen with #general open and focused, on a wide window. */
async function lookingAtGeneral() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    // Wide: the layout's min-width queries hold and its max-width ones do not.
    matches: !query.includes("max-width"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const connect = vi.spyOn(WorkspaceClient.prototype, "connect").mockImplementation(() => {});
  vi.spyOn(WorkspaceClient.prototype, "loadTimeline").mockResolvedValue(undefined as never);
  const notify = vi.fn();
  render(
    <App
      platform={{
        kind: "web",
        storage: {
          get: async <T,>(key: string) => (key === "servers" ? [rocket] : null) as T | null,
          set: async () => {},
        },
        notify,
      }}
    />,
  );
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
  const client = connect.mock.contexts[0] as WorkspaceClient;
  act(() =>
    client.store.setState({
      status: "online",
      workspaceName: "Rocket Team",
      self: sam,
      users: { [sam.id]: sam, [alex.id]: alex },
      channels: { [general.id]: general },
      memberships: { [general.id]: 0 },
    }),
  );
  await waitFor(() => expect(screen.getByRole("textbox", { name: /general/ })).toBeVisible());
  const arrive = (message: Message) =>
    act(() => client.onIncomingMessage?.(message, { live: true }));
  return { arrive, notify };
}

describe("notifying about a message in the conversation on screen", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stays quiet for a mention in the channel being read", async () => {
    const { arrive, notify } = await lookingAtGeneral();
    arrive(mention());
    expect(notify).not.toHaveBeenCalled();
  });

  it("tells about a mention in a thread that is not open, though its channel is", async () => {
    const { arrive, notify } = await lookingAtGeneral();
    // It used to be silenced because #general was selected, though the reply
    // shows only inside a thread nobody had open.
    arrive(mention({ id: "M_REPLY", threadRootId: "M_ROOT" }));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe("Alex Chen in #general");
  });
});
