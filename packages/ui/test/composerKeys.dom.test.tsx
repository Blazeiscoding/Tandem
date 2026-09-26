import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";

/**
 * The composer's keyboard and formatting: which key sends under each setting,
 * an input method's Enter never sending, formatting leaving the words
 * selected, and what a scheduled send says when the workspace is full.
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

async function renderComposer(enterSends = true) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam },
    channels: { [design.id]: design },
    status: "online",
  });
  const send = vi.spyOn(client, "send").mockImplementation(() => undefined);
  const values = new Map<string, unknown>();
  const platform: Platform = {
    kind: "web",
    storage: {
      get: async <T,>(name: string) =>
        (name === "composer-preferences" ? { enterSends } : (values.get(name) ?? null)) as T | null,
      set: async (name: string, value: unknown) => void values.set(name, value),
    },
    notify: () => {},
  };
  const { container } = render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <Composer channelId={design.id} placeholder="Message #design" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message #design" });
  await waitFor(() => expect(box).toBeEnabled());
  const filePicker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  return { client, send, box, filePicker };
}

const selected = (box: HTMLTextAreaElement) =>
  box.value.slice(box.selectionStart, box.selectionEnd);

describe("formatting in the composer", () => {
  it("wraps the selected words and leaves them selected, so a second style wraps the same words", async () => {
    const user = userEvent.setup();
    const { box } = await renderComposer();
    await user.type(box, "ship it today");
    box.setSelectionRange(5, 7);

    await user.click(screen.getByRole("button", { name: "Bold" }));
    expect(box).toHaveValue("ship *it* today");
    expect(selected(box)).toBe("it");
    expect(box).toHaveFocus();

    await user.keyboard("{Control>}i{/Control}");
    expect(box).toHaveValue("ship *_it_* today");
    expect(selected(box)).toBe("it");

    // The same style again takes it off.
    await user.click(screen.getByRole("button", { name: "Italic" }));
    expect(box).toHaveValue("ship *it* today");
    expect(selected(box)).toBe("it");
  });

  it("puts a placeholder in, selected, when nothing is selected", async () => {
    const user = userEvent.setup();
    const { box } = await renderComposer();
    await user.type(box, "see ");
    await user.click(screen.getByRole("button", { name: "Inline code" }));
    expect(box).toHaveValue("see `text`");
    expect(selected(box)).toBe("text");
  });
});

describe.each([
  { enterSends: true, sendKey: "{Enter}", newLineKey: "{Shift>}{Enter}{/Shift}" },
  { enterSends: false, sendKey: "{Control>}{Enter}{/Control}", newLineKey: "{Enter}" },
])("sending with enterSends=$enterSends", ({ enterSends, sendKey, newLineKey }) => {
  it("starts a new line with one key and sends with the other", async () => {
    const user = userEvent.setup();
    const { send, box } = await renderComposer(enterSends);
    await user.type(box, "first line");
    await user.keyboard(newLineKey);
    await user.type(box, "second line");
    expect(send).not.toHaveBeenCalled();
    expect(box).toHaveValue("first line\nsecond line");

    await user.keyboard(sendKey);
    expect(send).toHaveBeenCalledWith(design.id, "first line\nsecond line", {
      threadRootId: undefined,
      files: [],
      alsoSendToChannel: false,
    });
    expect(box).toHaveValue("");
  });

  it("never sends on the Enter an input method uses to choose a character", async () => {
    const { send, box } = await renderComposer(enterSends);
    fireEvent.change(box, { target: { value: "にほんご" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229, ctrlKey: true });
    expect(send).not.toHaveBeenCalled();
    expect(box).toHaveValue("にほんご");
  });
});

describe("a scheduled send that cannot upload its files", () => {
  it("says the workspace is full and keeps the draft and its file", async () => {
    const user = userEvent.setup();
    const { client, box, filePicker } = await renderComposer();
    vi.spyOn(client.api, "uploadFile").mockRejectedValue(
      new ApiError(507, "storage_quota_exceeded"),
    );
    const schedule = vi.spyOn(client.api, "scheduleMessage");
    await user.type(box, "The quarterly numbers");
    await user.upload(filePicker, new File(["1,2,3"], "numbers.csv", { type: "text/csv" }));
    expect(screen.getByText("numbers.csv")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Send later" }));
    fireEvent.change(screen.getByLabelText("Choose a date and time"), {
      target: { value: "2099-01-05T09:00" },
    });
    await user.click(screen.getByRole("button", { name: "Schedule message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Workspace attachment storage is full. Your draft is kept. Ask the host to free space or raise the limit, then retry.",
    );
    expect(schedule).not.toHaveBeenCalled();
    expect(box).toHaveValue("The quarterly numbers");
    expect(screen.getByText("numbers.csv")).toBeVisible();
  });
});
