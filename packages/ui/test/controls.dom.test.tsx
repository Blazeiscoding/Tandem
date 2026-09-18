import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient, type HuddleState } from "@slackoss/client-core";
import type { Channel, Message, User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { HuddleBar } from "../src/components/HuddleBar.js";
import { MessageItem } from "../src/components/MessageItem.js";
import { Sidebar } from "../src/components/Sidebar.js";
import { accessibilityProblems } from "./accessibility.js";

/** Emoji and pictographs, which used to stand in for the drawn icons. */
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

const person = (id: string, displayName: string): User => ({
  id,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

const room = (id: string, type: Channel["type"], name: string): Channel => ({
  id,
  type,
  name,
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
});

const sam = person("U_SAM", "Sam Rivera");
const priya = person("U_PRIYA", "Priya Shah");

/** A workspace client that never connects, holding the replica a test gives it. */
function offlineClient() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { U_SAM: sam, U_PRIYA: priya },
    status: "online",
    workspaceName: "Rocket Team",
  });
  return client;
}

describe("the huddle bar", () => {
  function huddleBar(state: Partial<HuddleState> = {}) {
    const client = offlineClient();
    client.store.setState({
      channels: { C_GENERAL: room("C_GENERAL", "public", "general") },
      huddle: {
        channelId: "C_GENERAL",
        micMuted: false,
        cameraOn: false,
        sharingScreen: false,
        localCameraStream: null,
        localScreenStream: null,
        speaking: false,
        peers: [
          {
            userId: "U_PRIYA",
            audioStream: null,
            cameraStream: null,
            screenStream: null,
            connected: true,
            micMuted: true,
            speaking: false,
          },
        ],
        ...state,
      },
    });
    const calls = {
      mic: vi.spyOn(client, "toggleMic").mockImplementation(() => {}),
      leave: vi.spyOn(client, "leaveHuddle").mockImplementation(() => {}),
    };
    render(
      <ClientContext.Provider value={client}>
        <HuddleBar />
      </ClientContext.Provider>,
    );
    return { client, calls, user: userEvent.setup() };
  }

  it("names each control for what it controls, and says whether it is on without renaming it", () => {
    const { client } = huddleBar();
    const controls = screen.getByRole("group", { name: "Huddle controls" });
    const toggles = ["Mute microphone", "Camera", "Share screen"];
    for (const name of toggles)
      expect(within(controls).getByRole("button", { name, pressed: false })).toBeInTheDocument();

    act(() =>
      client.store.setState((s) => ({
        huddle: { ...s.huddle!, micMuted: true, cameraOn: true, sharingScreen: true },
      })),
    );
    // A screen reader hears the same control, now pressed, not a different one.
    for (const name of toggles)
      expect(within(controls).getByRole("button", { name, pressed: true })).toBeInTheDocument();
    expect(within(controls).getAllByRole("button")).toHaveLength(4);
  });

  it("says who is in the huddle, and offers Leave in words", async () => {
    const { calls, user } = huddleBar();
    const region = screen.getByRole("region", { name: "Active huddle" });
    const people = within(region).getByRole("list", { name: "In the huddle" });
    expect(
      within(people)
        .getAllByRole("img")
        .map((face) => face.getAttribute("aria-label")),
    ).toEqual(["You", "Priya Shah (muted)"]);
    expect(within(region).getByRole("status")).toHaveTextContent("2 participants");

    await user.click(within(region).getByRole("button", { name: "Mute microphone" }));
    expect(calls.mic).toHaveBeenCalledOnce();
    await user.click(within(region).getByRole("button", { name: "Leave" }));
    expect(calls.leave).toHaveBeenCalledOnce();
    expect(region).not.toHaveTextContent(PICTOGRAPH);
    expect(await accessibilityProblems(region)).toEqual([]);
  });
});

describe("message actions", () => {
  const message: Message = {
    id: "M_1",
    channelId: "C_GENERAL",
    userId: "U_SAM",
    text: "Standup notes are in the doc.",
    threadRootId: null,
    broadcast: false,
    seq: 7,
    createdAt: 0,
    editedAt: null,
    nonce: null,
    replyCount: 0,
    reactions: [],
    files: [],
    pinned: true,
    actions: [],
  };

  function messageItem() {
    const client = offlineClient();
    client.store.setState({
      channels: { C_GENERAL: room("C_GENERAL", "public", "general") },
      saved: { M_1: true },
    });
    render(
      <ClientContext.Provider value={client}>
        <MessageItem message={message} compact={false} onOpenThread={vi.fn()} />
      </ClientContext.Provider>,
    );
  }

  it("names every action, since each one shows only an icon", async () => {
    messageItem();
    const toolbar = screen.getByRole("button", { name: "Reply in thread" }).parentElement!;
    const named = [
      "Reply in thread",
      "Copy link to message",
      "Remove from Later",
      "Mark unread from this message",
      "Unpin from channel",
      "Edit message",
      "Delete message",
    ];
    for (const name of named)
      expect(within(toolbar).getByRole("button", { name })).toBeInTheDocument();
    // The rest are the quick reactions, which are emoji on purpose.
    const reactions = within(toolbar)
      .getAllByRole("button")
      .filter((button) => PICTOGRAPH.test(button.textContent ?? ""));
    expect(reactions).toHaveLength(6);
    expect(within(toolbar).getAllByRole("button")).toHaveLength(named.length + reactions.length);
    expect(await accessibilityProblems(toolbar)).toEqual([]);
  });

  it("says a message is pinned or saved in words, without an emoji in front", () => {
    messageItem();
    // An exact match: "📌 Pinned to this channel" would not be found.
    expect(screen.getByText("Pinned to this channel")).toBeInTheDocument();
    expect(screen.getByText("Saved for later")).toBeInTheDocument();
  });
});

describe("channel rows", () => {
  it("say which channel is private, muted or in a huddle, which their icons alone would not", async () => {
    const client = offlineClient();
    client.store.setState({
      channels: {
        C_GENERAL: room("C_GENERAL", "public", "general"),
        C_LEADS: room("C_LEADS", "private", "leads"),
      },
      memberships: { C_GENERAL: 0, C_LEADS: 0 },
      prefs: { C_LEADS: { notifyLevel: "all", muted: true } },
      huddles: { C_GENERAL: ["U_PRIYA"] },
    });
    render(
      <ClientContext.Provider value={client}>
        <Sidebar
          activeChannelId={null}
          onSelect={vi.fn()}
          onBrowseChannels={vi.fn()}
          onNewChannel={vi.fn()}
          onNewDm={vi.fn()}
          onFriends={vi.fn()}
          onSearch={vi.fn()}
          onSaved={vi.fn()}
          onScheduled={vi.fn()}
          onActivity={vi.fn()}
          onThreads={vi.fn()}
          onEditProfile={vi.fn()}
          onInvite={vi.fn()}
          onSwitchWorkspace={vi.fn()}
          onAccountSettings={vi.fn()}
          connectionLabel={null}
        />
      </ClientContext.Provider>,
    );
    const nav = screen.getByRole("navigation", { name: "Workspace navigation" });
    // jsdom lays nothing out, so it does not put the spaces between flex items
    // that a browser does; the names are matched with and without them.
    expect(
      within(nav).getByRole("button", { name: /^Private channel ?leads ?Muted$/ }),
    ).toBeVisible();
    expect(
      within(nav).getByRole("button", { name: /^# ?general ?Huddle in progress$/ }),
    ).toBeVisible();
    expect(within(nav).getByRole("button", { name: "New channel" })).toBeVisible();
    expect(within(nav).getByRole("button", { name: "New message" })).toBeVisible();
    expect(nav).not.toHaveTextContent(PICTOGRAPH);
    expect(await accessibilityProblems(nav)).toEqual([]);
  });
});
