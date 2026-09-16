import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { User } from "@slackoss/protocol";
import { ClientContext } from "../src/context.js";
import { PeopleDialog } from "../src/components/PeopleDialog.js";
import { accessibilityProblems } from "./accessibility.js";

const owner: User = {
  id: "U_SAM",
  handle: "sam",
  displayName: "Sam Rivera",
  role: "owner",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
  canInvite: true,
};

const member: User = {
  id: "U_ALEX",
  handle: "alex",
  displayName: "Alex Chen",
  role: "member",
  statusText: "",
  statusEmoji: "",
  isBot: false,
  deactivated: false,
  dndUntil: null,
  createdAt: 0,
  canInvite: true,
};

/** The People dialog over a client whose admin API answers from stubs. */
async function people(fill: (api: WorkspaceClient["api"]) => void = () => {}) {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: owner, users: { U_SAM: owner, U_ALEX: member }, status: "online" });
  vi.spyOn(client.api, "listAllUsers").mockResolvedValue({
    users: [
      { ...owner, lastSeenAt: null },
      { ...member, lastSeenAt: null },
    ],
  });
  fill(client.api);
  render(
    <ClientContext.Provider value={client}>
      <PeopleDialog onClose={() => {}} />
    </ClientContext.Provider>,
  );
  const dialog = screen.getByRole("dialog", { name: "People" });
  await within(dialog).findByText("@alex");
  return { dialog: within(dialog), root: dialog, user: userEvent.setup(), client };
}

describe("people actions", () => {
  it("offers one menu per person instead of a row of buttons", async () => {
    const { dialog, root, user } = await people();
    // The owner's own row offers nothing: you cannot lock yourself out.
    const ownerRow = dialog.getByText("@sam").closest("li")!;
    expect(within(ownerRow).queryByRole("button")).toBeNull();

    const memberRow = dialog.getByText("@alex").closest("li")!;
    const actions = within(memberRow).getByRole("button", { name: "Actions for Alex Chen" });
    await user.click(actions);
    const menu = screen.getByRole("menu", { name: "Actions for Alex Chen" });
    for (const item of [
      "Make admin",
      "Stop inviting",
      "Deactivate",
      "Reset password",
      "Transfer ownership",
    ]) {
      expect(within(menu).getByRole("menuitem", { name: item })).toBeVisible();
    }
    expect(await accessibilityProblems(root)).toEqual([]);
  });

  it("deactivates through the menu", async () => {
    const update = vi.fn().mockResolvedValue({ user: { ...member, deactivated: true } });
    const { dialog, user } = await people((api) => {
      vi.spyOn(api, "updateUserAdmin").mockImplementation(update);
    });
    const memberRow = dialog.getByText("@alex").closest("li")!;
    await user.click(within(memberRow).getByRole("button", { name: "Actions for Alex Chen" }));
    await user.click(screen.getByRole("menuitem", { name: "Deactivate" }));
    expect(update).toHaveBeenCalledWith("U_ALEX", { deactivated: true });
  });
});
