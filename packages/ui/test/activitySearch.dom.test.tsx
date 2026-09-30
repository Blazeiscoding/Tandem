import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { Channel, Message, User } from "@slackoss/protocol";
import { describe, expect, it, vi } from "vitest";
import { ActivityPanel } from "../src/components/ActivityPanel.js";
import { SearchDialog } from "../src/components/SearchDialog.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";

/**
 * Activity and search over the network: a first load, a failure and Retry,
 * an empty answer said as such, the next page, and an answer that arrives
 * after a newer question was asked.
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
const priya: User = { ...sam, id: "U_PRIYA", handle: "priya", displayName: "Priya Shah" };

const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id, priya.id],
};
const hidden: Channel = { ...design, id: "C_HIDDEN", name: "hidden" };

const message = (id: string, text: string, seq: number, channelId = design.id): Message =>
  ({
    id,
    channelId,
    userId: priya.id,
    text,
    seq,
    createdAt: Date.UTC(2026, 8, 20, 10, 0),
    editedAt: null,
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    reactions: [],
    files: [],
    pinned: false,
  }) as unknown as Message;

function workspace() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    workspaceId: "W1",
    users: { [sam.id]: sam, [priya.id]: priya },
    channels: { [design.id]: design, [hidden.id]: hidden },
    // Read through seq 1 of #design; not a member of #hidden.
    memberships: { [design.id]: 1 },
    status: "online",
  });
  const platform: Platform = {
    kind: "web",
    storage: { get: async () => null, set: async () => {} },
    notify: () => {},
  };
  return { client, platform };
}

describe("the Activity panel", () => {
  function renderActivity(
    activity: (
      mode: string,
      opts: { cursor?: string },
    ) => Promise<{ messages: Message[]; nextCursor: string | null }>,
  ) {
    const { client, platform } = workspace();
    const spy = vi
      .spyOn(client.api, "activity")
      .mockImplementation((mode, opts) => activity(mode, opts ?? {}));
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <ActivityPanel onClose={() => {}} onJump={() => {}} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    return { spy, panel: screen.getByRole("complementary", { name: "Activity" }) };
  }

  it("loads its page again when retention takes threads from a conversation it shows", async () => {
    const { client, platform } = workspace();
    let answer = [message("M_OLD", "an old mention", 5), message("M_NEW", "a newer one", 6)];
    const spy = vi
      .spyOn(client.api, "activity")
      .mockImplementation(async () => ({ messages: answer, nextCursor: null }));
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <ActivityPanel onClose={() => {}} onJump={() => {}} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const panel = screen.getByRole("complementary", { name: "Activity" });
    await within(panel).findByText("an old mention");
    expect(spy).toHaveBeenCalledTimes(1);

    // Another conversation's removal is nothing to this page.
    act(() => client.store.setState({ removedHistory: { [hidden.id]: 20 } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy).toHaveBeenCalledTimes(1);

    answer = [message("M_NEW", "a newer one", 6)];
    act(() => client.store.setState({ removedHistory: { [hidden.id]: 20, [design.id]: 21 } }));
    await waitFor(() => expect(within(panel).queryByText("an old mention")).toBeNull());
    expect(within(panel).getByText("a newer one")).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("says a load failed, and Retry loads it", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { panel, spy } = renderActivity(async () => {
      if (fail) throw new TypeError("Failed to fetch");
      return { messages: [message("M2", "Can you look at the mockups?", 2)], nextCursor: null };
    });
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent(
      "Could not load activity. Check your connection and try again.",
    );
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(panel).findByText("Can you look at the mockups?")).toBeVisible();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("says when there is nothing, in the words for each filter", async () => {
    const user = userEvent.setup();
    const { panel } = renderActivity(async () => ({ messages: [], nextCursor: null }));
    expect(await within(panel).findByText("You're caught up.")).toBeVisible();
    await user.click(within(panel).getByRole("tab", { name: "Mentions" }));
    expect(await within(panel).findByText("No mentions yet.")).toBeVisible();
  });

  it("leaves out what is already read, and conversations it is not in", async () => {
    const { panel } = renderActivity(async () => ({
      messages: [
        message("M3", "New in design", 3),
        message("M1", "Already read", 1),
        message("M9", "From a room it left", 9, hidden.id),
      ],
      nextCursor: null,
    }));
    expect(await within(panel).findByText("New in design")).toBeVisible();
    expect(within(panel).queryByText("Already read")).toBeNull();
    expect(within(panel).queryByText("From a room it left")).toBeNull();
  });

  it("keeps a reply the channel was read past, until its thread is read", async () => {
    const reply = {
      ...message("M5", "A reply only in its thread", 5),
      threadRootId: "M0",
      broadcast: false,
    } as Message;
    const { client, platform } = workspace();
    // The channel is read past the reply; replies before seq 2 count as read.
    client.store.setState({ memberships: { [design.id]: 9 }, repliesRead: { [design.id]: 2 } });
    vi.spyOn(client.api, "activity").mockResolvedValue({ messages: [reply], nextCursor: null });
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <ActivityPanel onClose={() => {}} onJump={() => {}} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const panel = screen.getByRole("complementary", { name: "Activity" });
    expect(await within(panel).findByText("A reply only in its thread")).toBeVisible();

    client.store.setState({
      threadFollows: {
        M0: {
          rootId: "M0",
          channelId: design.id,
          following: false,
          lastReadSeq: 5,
          lastSeq: 5,
          revision: 1,
        },
      },
    });
    await waitFor(() => expect(within(panel).queryByText("A reply only in its thread")).toBeNull());
  });

  it("goes to the next page by its cursor and back again", async () => {
    const user = userEvent.setup();
    const { panel, spy } = renderActivity(async (_mode, { cursor }) =>
      cursor
        ? { messages: [message("M2", "Older", 2)], nextCursor: null }
        : { messages: [message("M5", "Newer", 5)], nextCursor: "M5" },
    );
    await within(panel).findByText("Newer");
    expect(within(panel).getByRole("button", { name: "Previous page" })).toBeDisabled();
    await user.click(within(panel).getByRole("button", { name: "Next page" }));
    expect(await within(panel).findByText("Older")).toBeVisible();
    expect(spy).toHaveBeenLastCalledWith("unread", expect.objectContaining({ cursor: "M5" }));
    expect(within(panel).getByRole("button", { name: "Next page" })).toBeDisabled();
    await user.click(within(panel).getByRole("button", { name: "Previous page" }));
    expect(await within(panel).findByText("Newer")).toBeVisible();
  });
});

describe("the search dialog", () => {
  function renderSearch(
    search: (
      q: string,
      opts: { cursor?: string },
    ) => Promise<{ messages: Message[]; nextCursor: string | null }>,
  ) {
    const { client, platform } = workspace();
    const spy = vi
      .spyOn(client.api, "search")
      .mockImplementation((q, _limit, opts) => search(q, opts ?? {}));
    render(
      <PlatformContext.Provider value={platform}>
        <ClientContext.Provider value={client}>
          <SearchDialog onClose={() => {}} onJump={() => {}} />
        </ClientContext.Provider>
      </PlatformContext.Provider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Search messages" });
    const box = within(dialog).getByRole("textbox", { name: "Search messages" });
    return { spy, dialog, box };
  }

  it("says back the days it was given, and which ones are not dates", async () => {
    const user = userEvent.setup();
    const { dialog, box } = renderSearch(async () => {
      throw new ApiError(
        400,
        "invalid_search_date",
        "Not a date: before:2026-02-31. Write dates as YYYY-MM-DD.",
      );
    });
    await user.type(box, "after:2026-03-08 before:2026-02-31");
    const day = new Date(Date.UTC(2026, 2, 8)).toLocaleDateString(undefined, { timeZone: "UTC" });
    // The day that was named, not the one the bound happens to start on.
    expect(within(dialog).getByText(`after ${day}`)).toBeVisible();
    expect(within(dialog).getByText("not a date: before:2026-02-31")).toBeVisible();

    await user.keyboard("{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Not a date: before:2026-02-31. Write dates as YYYY-MM-DD.",
    );
  });

  it("says a search failed, and Retry asks the same question again", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { dialog, box, spy } = renderSearch(async () => {
      if (fail) throw new TypeError("Failed to fetch");
      return { messages: [message("M2", "The mockups are ready", 2)], nextCursor: null };
    });
    await user.type(box, "mockups{Enter}");
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(
      "Could not search this workspace. Check your connection and try again.",
    );
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(dialog).queryByRole("alert")).toBeNull());
    expect(dialog).toHaveTextContent("1 results · Page 1 · Newest first · “mockups”");
    expect(spy.mock.calls.map((call) => call[0])).toEqual(["mockups", "mockups"]);
  });

  it("says when nothing matched", async () => {
    const user = userEvent.setup();
    const { dialog, box } = renderSearch(async () => ({ messages: [], nextCursor: null }));
    await user.type(box, "zebra{Enter}");
    expect(await within(dialog).findByText("Nothing matched. Try different words.")).toBeVisible();
  });

  it("goes to the next page by its cursor", async () => {
    const user = userEvent.setup();
    const { dialog, box, spy } = renderSearch(async (_q, { cursor }) =>
      cursor
        ? { messages: [message("M1", "Older mockups", 1)], nextCursor: null }
        : { messages: [message("M5", "Newer mockups", 5)], nextCursor: "M5" },
    );
    await user.type(box, "mockups{Enter}");
    await within(dialog).findByText(/Newer/);
    await user.click(within(dialog).getByRole("button", { name: "Next page" }));
    await within(dialog).findByText(/Older/);
    expect(dialog).toHaveTextContent("1 results · Page 2");
    expect(spy).toHaveBeenLastCalledWith("mockups", 30, expect.objectContaining({ cursor: "M5" }));
  });

  it("says it is searching, and does not ask again until it has an answer", async () => {
    const user = userEvent.setup();
    let answer!: (value: { messages: Message[]; nextCursor: null }) => void;
    const { dialog, box, spy } = renderSearch(() => new Promise((resolve) => (answer = resolve)));
    await user.type(box, "mockups{Enter}");
    expect(within(dialog).getByRole("status")).toHaveTextContent("Searching…");
    const submit = within(dialog).getByRole("button", { name: "Search" });
    expect(submit).toBeDisabled();
    await user.type(box, "{Enter}");
    expect(spy).toHaveBeenCalledOnce();

    answer({ messages: [message("M2", "The mockups are ready", 2)], nextCursor: null });
    await within(dialog).findByText(/are ready/);
    expect(submit).toBeEnabled();
  });
});
