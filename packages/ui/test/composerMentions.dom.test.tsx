import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, Message, User } from "@slackoss/protocol";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../src/components/Composer.js";
import { MessageEditor } from "../src/components/MessageEditor.js";
import { ClientContext, PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";

/**
 * A message box shows mentions as names, while what it sends, saves and
 * keeps as a draft names them by id, as the server's mentions go by.
 */
const person = (id: string, handle: string, displayName: string): User => ({
  id,
  handle,
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
});

const sam = person("U_SAM", "sam", "Sam Rivera");
const sadia = person("U_SADIA", "sadia", "Sadia Khan");
// Another Sadia Khan: the same name, somebody else.
const sadia2 = person("U_SADIA2", "skhan", "Sadia Khan");
const kai = person("U_KAI", "kai", "Kai");

const design: Channel = {
  id: "C_DESIGN",
  type: "public",
  name: "design",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id, sadia.id, sadia2.id, kai.id],
};

const platform: Platform = {
  kind: "web",
  storage: { get: async () => null, set: async () => {} },
  notify: () => {},
};

function workspace(drafts: Record<string, string> = {}) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: Object.fromEntries([sam, sadia, sadia2, kai].map((u) => [u.id, u])),
    channels: { [design.id]: design },
    drafts,
    status: "online",
  });
  const send = vi.spyOn(client, "send").mockReturnValue(true);
  return { client, send };
}

async function renderComposer(drafts?: Record<string, string>) {
  const { client, send } = workspace(drafts);
  render(
    <PlatformContext.Provider value={platform}>
      <ClientContext.Provider value={client}>
        <Composer channelId={design.id} placeholder="Message #design" />
      </ClientContext.Provider>
    </PlatformContext.Provider>,
  );
  const box = screen.getByRole("textbox", { name: "Message #design" }) as HTMLTextAreaElement;
  await waitFor(() => expect(box).toBeEnabled());
  return { box, client, send, user: userEvent.setup() };
}

/** What was sent last. */
const sent = (send: ReturnType<typeof workspace>["send"]) => send.mock.lastCall?.[1];

/** Undo or Redo as the browser does it: the old characters, said to be history. */
function history(box: HTMLTextAreaElement, value: string, inputType: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(box, value);
  box.setSelectionRange(value.length, value.length);
  fireEvent(box, new InputEvent("input", { bubbles: true, inputType }));
}

describe("a mention in the composer", () => {
  it("shows @here when @here is chosen, and sends <!here>", async () => {
    const { box, send, user } = await renderComposer();
    await user.type(box, "Lunch @he");
    await user.keyboard("{Tab}");
    expect(box).toHaveValue("Lunch @here ");
    expect(box.selectionStart).toBe("Lunch @here ".length);
    await user.type(box, "now{Enter}");
    expect(sent(send)).toBe("Lunch <!here> now");
  });

  it("sends the person chosen, not another with the same name", async () => {
    const { box, send, user } = await renderComposer();
    await user.type(box, "@sadia");
    await user.click(screen.getByRole("option", { name: /@skhan/ }));
    expect(box).toHaveValue("@Sadia Khan ");
    await user.keyboard("{Enter}");
    expect(sent(send)).toBe(`<@${sadia2.id}>`);
  });

  it("keeps sending the person chosen after they change their name", async () => {
    const { box, client, send, user } = await renderComposer();
    await user.type(box, "@sam");
    await user.keyboard("{Tab}");
    act(() =>
      client.store.setState((s) => ({
        users: { ...s.users, [sam.id]: { ...sam, displayName: "Sam R." } },
      })),
    );
    expect(box).toHaveValue("@Sam R. ");
    await user.type(box, "{Enter}");
    expect(sent(send)).toBe(`<@${sam.id}>`);
  });

  it("restores a saved draft's mentions as names, keeping the draft as it was", async () => {
    const draft = `<@${sadia.id}> and <!channel> in <#${design.id}>, ask <@U_GONE>`;
    const { box, client, send, user } = await renderComposer({ [design.id]: draft });
    expect(box).toHaveValue("@Sadia Khan and @channel in #design, ask @unknown");
    expect(client.state.drafts[design.id]).toBe(draft);
    await user.click(box);
    await user.keyboard("{Enter}");
    expect(sent(send)).toBe(draft);
  });

  it("takes a whole mention with one Backspace, and Undo brings the mention back", async () => {
    const { box, client, send, user } = await renderComposer();
    await user.type(box, "hi @sad");
    await user.keyboard("{Tab}{Backspace}{Backspace}");
    expect(box).toHaveValue("hi ");
    await waitFor(() => expect(client.state.drafts[design.id]).toBe("hi "));
    history(box, "hi @Sadia Khan", "historyUndo");
    expect(box).toHaveValue("hi @Sadia Khan");
    await user.keyboard("{Enter}");
    expect(sent(send)).toBe(`hi <@${sadia.id}>`);
  });

  it("turns a mention whose name is edited into the words left, mentioning nobody", async () => {
    const { box, send, user } = await renderComposer();
    await user.type(box, "@sad");
    await user.keyboard("{Tab}");
    box.setSelectionRange(6, 6);
    await user.keyboard("{Backspace}");
    expect(box).toHaveValue("@Sadi Khan ");
    // "@Sadi" is being typed again, so the suggestions open; they are declined.
    expect(screen.getByRole("listbox", { name: "Mentions" })).toBeVisible();
    await user.keyboard("{Escape}{Enter}");
    expect(sent(send)).toBe("@Sadi Khan");
  });

  it("never makes a pasted name a mention", async () => {
    const { box, send, user } = await renderComposer();
    await user.click(box);
    await user.paste("@Sadia Khan and @here now");
    await user.keyboard("{Enter}");
    expect(sent(send)).toBe("@Sadia Khan and @here now");
  });

  it("formats a selected mention around its token, keeping it a mention", async () => {
    const { box, send, user } = await renderComposer();
    await user.type(box, "ask @sad");
    await user.keyboard("{Tab}");
    box.setSelectionRange(4, 15);
    await user.keyboard("{Control>}b{/Control}");
    expect(box).toHaveValue("ask *@Sadia Khan* ");
    expect([box.selectionStart, box.selectionEnd]).toEqual([5, 16]);
    await user.keyboard("{End}{Enter}");
    expect(sent(send)).toBe(`ask *<@${sadia.id}>*`);
  });

  it("does not offer a mention again for one already made", async () => {
    const { box, send, user } = await renderComposer();
    await user.type(box, "@ka");
    await user.keyboard("{Tab}{Backspace}");
    // The caret is after "@Kai", which reads like a mention being typed.
    expect(box).toHaveValue("@Kai");
    expect(screen.queryByRole("listbox", { name: "Mentions" })).toBeNull();
    await user.keyboard("{Enter}");
    expect(sent(send)).toBe(`<@${kai.id}>`);
  });
});

describe("a mention in a message being edited", () => {
  const message = {
    id: "M1",
    channelId: design.id,
    userId: sam.id,
    text: `Ship it <@${sadia.id}> <!here>`,
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

  function renderEditor() {
    const { client } = workspace();
    const edit = vi
      .spyOn(client.api, "editMessage")
      .mockImplementation(async (_id, text) => ({ message: { ...message, text } }));
    const view = render(
      <ClientContext.Provider value={client}>
        <MessageEditor message={message} onClose={() => {}} />
      </ClientContext.Provider>,
    );
    const rerender = (next: Message) =>
      view.rerender(
        <ClientContext.Provider value={client}>
          <MessageEditor message={next} onClose={() => {}} />
        </ClientContext.Provider>,
      );
    const box = screen.getByRole("textbox", { name: "Edit message" }) as HTMLTextAreaElement;
    return { client, edit, box, rerender };
  }

  it("shows names, and saves ids with the edit", async () => {
    const user = userEvent.setup();
    const { client, edit, box } = renderEditor();
    expect(box).toHaveValue("Ship it @Sadia Khan @here");
    await user.type(box, " today");
    expect(JSON.parse(client.state.drafts[`${design.id}:edit:M1`]!)).toEqual({
      text: `Ship it <@${sadia.id}> <!here> today`,
      base: message.text,
    });
    await user.keyboard("{Enter}");
    expect(edit).toHaveBeenCalledWith("M1", `Ship it <@${sadia.id}> <!here> today`, message.text);
  });

  it("shows the message as changed elsewhere with names too", async () => {
    const user = userEvent.setup();
    const { box, rerender } = renderEditor();
    await user.type(box, "!");
    rerender({ ...message, text: `Ship it Monday <@${sadia.id}>` });
    expect(screen.getByRole("blockquote", { name: "Current message" })).toHaveTextContent(
      "Ship it Monday @Sadia Khan",
    );
  });
});
