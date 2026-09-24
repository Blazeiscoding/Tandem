import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, WorkspaceClient } from "@slackoss/client-core";
import type { Channel, User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { EditProfileDialog, ProfileDialog } from "../src/components/ProfileDialog.js";
import { accessibilityProblems } from "./accessibility.js";

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
const priya = person("U_PRIYA", "priya", "Priya Natarajan");

const dm: Channel = {
  id: "D_PRIYA",
  type: "dm",
  name: "",
  topic: "",
  description: "",
  creatorId: sam.id,
  archived: false,
  createdAt: 0,
  memberIds: [sam.id, priya.id],
};

/** A workspace client that never connects, holding Sam and Priya. */
function workspace() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({
    self: sam,
    users: { [sam.id]: sam, [priya.id]: priya },
    status: "online",
  });
  return client;
}

describe("someone else's profile", () => {
  it("says a conversation did not open, and opens it on the next press", async () => {
    const user = userEvent.setup();
    const client = workspace();
    const openDm = vi
      .spyOn(client, "openDm")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(dm);
    const onOpenDm = vi.fn();
    render(
      <ClientContext.Provider value={client}>
        <ProfileDialog userId={priya.id} onClose={() => {}} onOpenDm={onOpenDm} />
      </ClientContext.Provider>,
    );
    const message = screen.getByRole("button", { name: "Message Priya Natarajan" });
    await user.click(message);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not open a conversation with Priya Natarajan. Check your connection and try again.",
    );
    expect(onOpenDm).not.toHaveBeenCalled();
    expect(message).toHaveFocus();
    expect(await accessibilityProblems(screen.getByRole("dialog", { name: "Profile" }))).toEqual(
      [],
    );

    await user.click(message);
    expect(openDm).toHaveBeenCalledTimes(2);
    expect(onOpenDm).toHaveBeenCalledWith(dm.id);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("editing your own profile", () => {
  it("keeps what was typed when saving fails, and closes once it saves", async () => {
    const user = userEvent.setup();
    const client = workspace();
    const updateMe = vi
      .spyOn(client.api, "updateMe")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ user: { ...sam, statusText: "Heads down" } });
    const onClose = vi.fn();
    render(
      <ClientContext.Provider value={client}>
        <EditProfileDialog onClose={onClose} />
      </ClientContext.Provider>,
    );
    const name = screen.getByRole("textbox", { name: "Display name" });
    const status = screen.getByRole("textbox", { name: "Status text" });
    await user.clear(name);
    await user.type(name, "Sam R.");
    await user.type(status, "Heads down");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your profile was not saved. Check your connection and try again.",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(name).toHaveValue("Sam R.");
    expect(status).toHaveValue("Heads down");

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(updateMe).toHaveBeenLastCalledWith({
      displayName: "Sam R.",
      statusEmoji: "",
      statusText: "Heads down",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("explains a refused profile and limits each field to what the server accepts", async () => {
    const user = userEvent.setup();
    const client = workspace();
    vi.spyOn(client.api, "updateMe").mockRejectedValueOnce(new ApiError(400, "invalid_request"));
    render(
      <ClientContext.Provider value={client}>
        <EditProfileDialog onClose={() => {}} />
      </ClientContext.Provider>,
    );
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveAttribute(
      "maxlength",
      "80",
    );
    expect(screen.getByRole("textbox", { name: "Status emoji" })).toHaveAttribute(
      "maxlength",
      "32",
    );
    expect(screen.getByRole("textbox", { name: "Status text" })).toHaveAttribute(
      "maxlength",
      "120",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A display name can be up to 80 characters and a status up to 120.",
    );
  });
});
