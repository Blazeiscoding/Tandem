import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { QuickSwitcher } from "../src/components/QuickSwitcher.js";

const person = (id: string, handle: string, displayName: string, deactivated = false): User => ({
  id,
  handle,
  displayName,
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated,
  dndUntil: null,
  createdAt: 0,
});

const room = (
  id: string,
  type: Channel["type"],
  name: string,
  memberIds: string[] = [],
): Channel => ({
  id,
  type,
  name,
  topic: "",
  description: "",
  creatorId: "U_SAM",
  archived: false,
  createdAt: 0,
  memberIds,
});

/** A workspace client that never connects, holding the replica a test gives it. */
function switcherWith() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  const sam = person("U_SAM", "sam", "Sam Rivera");
  client.store.setState({
    self: sam,
    users: {
      U_SAM: sam,
      U_ALEX: person("U_ALEX", "alex", "Alex Chen"),
      U_PRIYA: person("U_PRIYA", "priya", "Priya Natarajan"),
      U_DANA: person("U_DANA", "dana", "Dana Old", true),
    },
    channels: {
      C_DESIGN: room("C_DESIGN", "public", "design"),
      C_LEADS: room("C_LEADS", "private", "leads"),
      D_ALEX: room("D_ALEX", "dm", "", ["U_SAM", "U_ALEX"]),
      D_DANA: room("D_DANA", "dm", "", ["U_SAM", "U_DANA"]),
      G_TRIO: room("G_TRIO", "group_dm", "", ["U_SAM", "U_ALEX", "U_PRIYA"]),
    },
  });
  const onOpen = vi.fn();
  const openDm = vi.spyOn(client, "openDm").mockResolvedValue(room("D_PRIYA", "dm", ""));
  render(
    <ClientContext.Provider value={client}>
      <QuickSwitcher onClose={() => {}} onOpen={onOpen} />
    </ClientContext.Provider>,
  );
  const options = () =>
    within(screen.getByRole("dialog", { name: "Jump to" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent);
  return { onOpen, openDm, options };
}

describe("jumping to a conversation", () => {
  it("lists a person once, whether or not you already talk to them directly", () => {
    const { options } = switcherWith();
    expect(options()).toEqual([
      "#design",
      "leads",
      "@Dana Old",
      "@Alex Chen, Priya Natarajan",
      "@Alex Chen",
      "@Priya Natarajan",
    ]);
  });

  it("opens an existing direct conversation without asking the server for it", async () => {
    const user = userEvent.setup();
    const { onOpen, openDm } = switcherWith();
    await user.click(screen.getByRole("button", { name: "Alex Chen" }));
    expect(onOpen).toHaveBeenCalledWith("D_ALEX");
    expect(openDm).not.toHaveBeenCalled();
  });

  it("starts a direct conversation with someone you have not talked to yet", async () => {
    const user = userEvent.setup();
    const { onOpen, openDm } = switcherWith();
    await user.click(screen.getByRole("button", { name: "Priya Natarajan" }));
    expect(openDm).toHaveBeenCalledWith(["U_PRIYA"]);
    expect(onOpen).toHaveBeenCalledWith("D_PRIYA");
  });

  it("finds a channel or a person written the way they are written in messages", async () => {
    const user = userEvent.setup();
    const { options } = switcherWith();
    await user.type(screen.getByPlaceholderText("Channel or person"), "#des");
    expect(options()).toEqual(["#design"]);
    await user.clear(screen.getByPlaceholderText("Channel or person"));
    await user.type(screen.getByPlaceholderText("Channel or person"), "@pri");
    expect(options()).toEqual(["@Alex Chen, Priya Natarajan", "@Priya Natarajan"]);
  });
});
