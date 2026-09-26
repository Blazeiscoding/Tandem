import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { Message, User } from "@slackoss/protocol";
import { describe, expect, it, vi } from "vitest";
import { MessageEditor } from "../src/components/MessageEditor.js";
import { ClientContext } from "../src/context.js";

/**
 * Editing a message in place: what saving, cancelling and failing do to the
 * text being edited, and what happens when someone else edits it first.
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

const original: Message = {
  id: "M1",
  channelId: "C1",
  userId: sam.id,
  text: "Ship it on Friday",
  seq: 1,
  createdAt: 0,
  editedAt: null,
  threadRootId: null,
  replyCount: 0,
  lastReplyAt: null,
  reactions: [],
  files: [],
  pinned: false,
} as unknown as Message;

const draftKey = "C1:edit:M1";

function renderEditor(message = original) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, status: "online" });
  const edit = vi
    .spyOn(client.api, "editMessage")
    .mockImplementation(async (_id, text) => ({ message: { ...message, text } }));
  const onClose = vi.fn();
  const view = render(
    <ClientContext.Provider value={client}>
      <MessageEditor message={message} onClose={onClose} />
    </ClientContext.Provider>,
  );
  const rerender = (next: Message) =>
    view.rerender(
      <ClientContext.Provider value={client}>
        <MessageEditor message={next} onClose={onClose} />
      </ClientContext.Provider>,
    );
  const box = screen.getByRole("textbox", { name: "Edit message" });
  return { client, edit, onClose, box, rerender };
}

describe("editing a message", () => {
  it("saves the trimmed text with Enter, closes, and forgets the draft", async () => {
    const user = userEvent.setup();
    const { client, edit, onClose, box } = renderEditor();
    expect(box).toHaveFocus();
    await user.clear(box);
    await user.type(box, "  Ship it on Monday  ");
    expect(client.state.drafts[draftKey]).toBe("  Ship it on Monday  ");
    await user.keyboard("{Enter}");
    expect(edit).toHaveBeenCalledWith("M1", "Ship it on Monday");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(client.state.drafts).not.toHaveProperty([draftKey]);
  });

  it("closes without asking the server when nothing changed", async () => {
    const user = userEvent.setup();
    const { edit, onClose } = renderEditor();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(edit).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("throws the edit away on Cancel or Escape, and Escape goes no further", async () => {
    const user = userEvent.setup();
    const { client, edit, onClose, box } = renderEditor();
    await user.type(box, " and Monday");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(client.state.drafts).not.toHaveProperty([draftKey]);
    expect(edit).not.toHaveBeenCalled();

    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    try {
      fireEvent.keyDown(box, { key: "Escape" });
    } finally {
      document.removeEventListener("keydown", outer);
    }
    expect(onClose).toHaveBeenCalledTimes(2);
    // A dialog around the message stays open.
    expect(outer).not.toHaveBeenCalled();
  });

  it("stays open with the text kept when saving fails, and saves on the next try", async () => {
    const user = userEvent.setup();
    const { client, edit, onClose, box } = renderEditor();
    edit.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await user.clear(box);
    await user.type(box, "Ship it on Monday{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save this edit. Your text is kept; try again when connected.",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(box).toHaveValue("Ship it on Monday");
    expect(client.state.drafts[draftKey]).toBe("Ship it on Monday");

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it("says when the message is gone, and keeps the edit", async () => {
    const user = userEvent.setup();
    const { edit, onClose, box } = renderEditor();
    edit.mockRejectedValueOnce(new ApiError(404, "message_not_found"));
    await user.type(box, "!{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This message is no longer available. Your unsaved edit is kept.",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(box).toHaveValue("Ship it on Friday!");
  });

  it("does not save while an input method is choosing a character", async () => {
    const { edit, onClose, box } = renderEditor();
    fireEvent.change(box, { target: { value: "金曜日に出荷" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(edit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("picks up a draft left from before, rather than the message's text", () => {
    const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
    client.store.setState({ self: sam, users: { [sam.id]: sam } });
    client.setDraft(draftKey, "Half an edit");
    render(
      <ClientContext.Provider value={client}>
        <MessageEditor message={original} onClose={() => {}} />
      </ClientContext.Provider>,
    );
    expect(screen.getByRole("textbox", { name: "Edit message" })).toHaveValue("Half an edit");
  });
});

describe("a message changed by someone else while it is being edited", () => {
  it("says so, and Enter no longer saves over it without a choice", async () => {
    const user = userEvent.setup();
    const { edit, box, rerender } = renderEditor();
    await user.type(box, " (mine)");
    rerender({ ...original, text: "Ship it on Thursday" });

    expect(screen.getByRole("status")).toHaveTextContent(
      "This message changed while you were editing.",
    );
    await user.keyboard("{Enter}");
    expect(edit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save my version" })).toBeEnabled();
  });

  it("saves their own version when they choose to", async () => {
    const user = userEvent.setup();
    const { edit, onClose, box, rerender } = renderEditor();
    await user.type(box, " (mine)");
    rerender({ ...original, text: "Ship it on Thursday" });
    await user.click(screen.getByRole("button", { name: "Save my version" }));
    expect(edit).toHaveBeenCalledWith("M1", "Ship it on Friday (mine)");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("takes the current message instead, and carries on editing from it", async () => {
    const user = userEvent.setup();
    const { edit, box, rerender } = renderEditor();
    await user.type(box, " (mine)");
    rerender({ ...original, text: "Ship it on Thursday" });
    await user.click(screen.getByRole("button", { name: "Use the current message" }));

    expect(box).toHaveValue("Ship it on Thursday");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await user.type(box, " at noon{Enter}");
    expect(edit).toHaveBeenCalledWith("M1", "Ship it on Thursday at noon");
  });
});
