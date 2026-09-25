import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceClient } from "@slackoss/client-core";
import type { ModalView, User } from "@slackoss/protocol";
import { describe, expect, it, vi } from "vitest";
import { ViewModal } from "../src/components/ViewModal.js";
import { ClientContext } from "../src/context.js";
import { accessibilityProblems } from "./accessibility.js";

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

const view: ModalView = {
  id: "V_1",
  callbackId: "expense",
  title: "File an expense",
  submitLabel: "Submit",
  closeLabel: "Cancel",
  privateMetadata: "",
  text: "",
  fields: [
    {
      blockId: "amount",
      actionId: "value",
      label: "Amount",
      hint: "In euros, without the sign.",
      optional: false,
      type: "text",
      placeholder: "",
      initialValue: "",
      options: [],
    },
    {
      blockId: "reason",
      actionId: "value",
      label: "Reason",
      hint: "",
      optional: true,
      type: "textarea",
      placeholder: "",
      initialValue: "",
      options: [],
    },
  ],
};

function renderForm() {
  const client = new WorkspaceClient("http://127.0.0.1:9", "test-token-not-a-credential");
  client.store.setState({ self: sam, users: { [sam.id]: sam }, modal: view, status: "online" });
  const submit = vi
    .spyOn(client, "submitModal")
    .mockResolvedValue({ ok: false, errors: { amount: "Enter an amount above zero." } });
  render(
    <ClientContext.Provider value={client}>
      <ViewModal />
    </ClientContext.Provider>,
  );
  return { submit, user: userEvent.setup() };
}

describe("an app's form", () => {
  it("ties each field to its hint, and says which fields are needed", async () => {
    renderForm();
    const amount = screen.getByRole("textbox", { name: "Amount" });
    expect(amount).toHaveAccessibleDescription("In euros, without the sign.");
    expect(amount).toHaveAttribute("aria-required", "true");
    expect(amount).not.toHaveAttribute("aria-invalid");
    const reason = screen.getByRole("textbox", { name: /^Reason/ });
    expect(reason).not.toHaveAttribute("aria-describedby");
    expect(reason).toHaveAttribute("aria-required", "false");
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);
  });

  it("keeps two fields apart when their blocks give them the same action id", async () => {
    const { submit, user } = renderForm();
    await user.type(screen.getByRole("textbox", { name: "Amount" }), "12");
    expect(screen.getByRole("textbox", { name: /^Reason/ })).toHaveValue("");
    await user.type(screen.getByRole("textbox", { name: /^Reason/ }), "Team lunch");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submit).toHaveBeenCalledWith({
      amount: { value: "12" },
      reason: { value: "Team lunch" },
    });
  });

  it("marks a field the app refused, reads its error with it, and takes somebody there", async () => {
    const { submit, user } = renderForm();
    await user.click(screen.getByRole("textbox", { name: /^Reason/ }));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(submit).toHaveBeenCalledOnce();
    const amount = screen.getByRole("textbox", { name: "Amount" });
    expect(await screen.findByText("Enter an amount above zero.")).toBeVisible();
    expect(amount).toHaveAttribute("aria-invalid", "true");
    // The error replaces the hint, as it does on screen.
    expect(amount).toHaveAccessibleDescription("Enter an amount above zero.");
    expect(amount).toHaveFocus();
    expect(screen.getByRole("textbox", { name: /^Reason/ })).not.toHaveAttribute("aria-invalid");
    expect(await accessibilityProblems(screen.getByRole("dialog"))).toEqual([]);
  });
});
