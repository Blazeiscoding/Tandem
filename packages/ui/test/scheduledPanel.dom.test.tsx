import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { Channel, ScheduledMessage, User } from "@slackoss/protocol";
import { describe, expect, it, vi } from "vitest";
import { ScheduledPanel } from "../src/components/ScheduledPanel.js";
import { ClientContext } from "../src/context.js";
import { accessibilityProblems } from "./accessibility.js";

/**
 * The Scheduled panel: its first load, a failed load and Refresh, and each
 * change it makes asking first and saying when it could not be confirmed.
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

const queued = (id: string, text: string, hours = 2): ScheduledMessage =>
  ({
    id,
    channelId: design.id,
    userId: sam.id,
    text,
    threadRootId: null,
    fileIds: [],
    sendAt: Date.now() + hours * 3600_000,
    status: "queued",
    failureReason: null,
    attempts: 0,
    messageId: null,
  }) as unknown as ScheduledMessage;

function renderPanel(list: () => Promise<{ scheduled: ScheduledMessage[] }>) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [design.id]: design },
    status: "online",
  });
  const api = {
    list: vi.spyOn(client.api, "listScheduled").mockImplementation(list),
    cancel: vi.spyOn(client.api, "cancelScheduled").mockResolvedValue({ ok: true } as never),
    reschedule: vi
      .spyOn(client.api, "rescheduleMessage")
      .mockImplementation(async (id, sendAt) => ({
        scheduled: { ...queued(id, "moved"), sendAt },
      })),
    edit: vi
      .spyOn(client.api, "editScheduledMessage")
      .mockImplementation(async (id, body) => ({ scheduled: { ...queued(id, body.text) } })),
  };
  render(
    <ClientContext.Provider value={client}>
      <ScheduledPanel onClose={() => {}} onJump={() => {}} />
    </ClientContext.Provider>,
  );
  const panel = screen.getByRole("complementary", { name: "Scheduled messages" });
  return { client, api, panel };
}

describe("the Scheduled panel", () => {
  it("stands in rows while it first loads, and says when there is nothing queued", async () => {
    let finish!: (value: { scheduled: ScheduledMessage[] }) => void;
    const { panel } = renderPanel(() => new Promise((resolve) => (finish = resolve)));
    expect(within(panel).getByRole("status")).toHaveTextContent("Loading scheduled messages…");
    finish({ scheduled: [] });
    expect(await within(panel).findByText(/Nothing queued/)).toBeVisible();
    expect(await accessibilityProblems(panel)).toEqual([]);
  });

  it("says a first load failed, and Refresh in the message loads it", async () => {
    const user = userEvent.setup();
    let fail = true;
    const { panel, api } = renderPanel(async () => {
      if (fail) throw new TypeError("Failed to fetch");
      return { scheduled: [queued("S1", "Standup notes")] };
    });
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveTextContent(
      "Could not refresh scheduled messages. The list below may be out of date.",
    );
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Refresh" }));
    expect(await within(panel).findByText("Standup notes")).toBeVisible();
    expect(within(panel).queryByRole("alert")).toBeNull();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("asks before removing a message, and Keep as is leaves it", async () => {
    const user = userEvent.setup();
    const { panel, api } = renderPanel(async () => ({
      scheduled: [queued("S1", "Standup notes")],
    }));
    await within(panel).findByText("Standup notes");
    await user.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(within(panel).getByText("Remove this scheduled message?")).toBeVisible();
    await user.click(within(panel).getByRole("button", { name: "Keep as is" }));
    expect(api.cancel).not.toHaveBeenCalled();
    expect(within(panel).queryByText("Remove this scheduled message?")).toBeNull();

    await user.click(within(panel).getByRole("button", { name: "Cancel" }));
    await user.click(within(panel).getByRole("button", { name: "Remove message" }));
    expect(api.cancel).toHaveBeenCalledWith("S1");
    await waitFor(() => expect(within(panel).queryByText("Standup notes")).toBeNull());
  });

  it("asks before sending now, and sends at once when confirmed", async () => {
    const user = userEvent.setup();
    const { panel, api } = renderPanel(async () => ({
      scheduled: [queued("S1", "Standup notes")],
    }));
    await within(panel).findByText("Standup notes");
    await user.click(within(panel).getByRole("button", { name: "Send now" }));
    expect(within(panel).getByText("Queue this message to send now?")).toBeVisible();
    const before = Date.now();
    await user.click(within(panel).getAllByRole("button", { name: "Send now" }).at(-1)!);
    expect(api.reschedule).toHaveBeenCalledOnce();
    const [id, sendAt] = api.reschedule.mock.calls[0]!;
    expect(id).toBe("S1");
    expect(sendAt).toBeGreaterThanOrEqual(before);
    expect(sendAt).toBeLessThanOrEqual(Date.now());
  });

  it("keeps the message and says to refresh when a change cannot be confirmed", async () => {
    const user = userEvent.setup();
    const { panel, api } = renderPanel(async () => ({
      scheduled: [queued("S1", "Standup notes")],
    }));
    api.cancel.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await within(panel).findByText("Standup notes");
    await user.click(within(panel).getByRole("button", { name: "Cancel" }));
    await user.click(within(panel).getByRole("button", { name: "Remove message" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "Could not confirm this change. Refresh the list before trying again; it may already have been sent or changed on another device.",
    );
    expect(within(panel).getByText("Standup notes")).toBeVisible();
  });

  it("refuses a new time in the past, and moves a message to a future one", async () => {
    const user = userEvent.setup();
    const { panel, api } = renderPanel(async () => ({
      scheduled: [queued("S1", "Standup notes")],
    }));
    await within(panel).findByText("Standup notes");
    await user.click(within(panel).getByRole("button", { name: "Change time" }));
    const field = within(panel).getByLabelText("New date and time");
    fireEvent.change(field, { target: { value: "2001-01-01T09:00" } });
    // The field's minimum stops a browser submitting this; the panel checks
    // again for one that does not validate, or a time that passed meanwhile.
    fireEvent.submit(field.closest("form")!);
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "Choose a time in the future.",
    );
    expect(api.reschedule).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "2099-01-05T09:00" } });
    await user.click(within(panel).getByRole("button", { name: "Save time" }));
    expect(api.reschedule).toHaveBeenCalledWith("S1", new Date("2099-01-05T09:00").getTime());
  });

  it("edits the text against what it started from, and keeps the draft when another device changed it", async () => {
    const user = userEvent.setup();
    const { panel, api, client } = renderPanel(async () => ({
      scheduled: [queued("S1", "Standup notes")],
    }));
    await within(panel).findByText("Standup notes");
    await user.click(within(panel).getByRole("button", { name: "Edit text" }));
    const box = within(panel).getByLabelText("Edit scheduled text");
    await user.clear(box);
    await user.type(box, "Standup moved to 10");

    api.edit.mockRejectedValueOnce(new ApiError(409, "scheduled_changed"));
    await user.click(within(panel).getByRole("button", { name: "Save text" }));
    expect(api.edit).toHaveBeenCalledWith("S1", {
      text: "Standup moved to 10",
      expectedText: "Standup notes",
    });
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "The text changed on another device. Refresh and load the current text before saving again. Your draft is kept.",
    );
    expect(box).toHaveValue("Standup moved to 10");
    expect(client.state.drafts["C_DESIGN:scheduled-edit:S1"]).toBe(
      JSON.stringify({ text: "Standup moved to 10" }),
    );

    await user.click(within(panel).getByRole("button", { name: "Save text" }));
    await waitFor(() => expect(within(panel).queryByLabelText("Edit scheduled text")).toBeNull());
    expect(within(panel).getByText("Standup moved to 10")).toBeVisible();
    expect(client.state.drafts).not.toHaveProperty(["C_DESIGN:scheduled-edit:S1"]);
  });
});
