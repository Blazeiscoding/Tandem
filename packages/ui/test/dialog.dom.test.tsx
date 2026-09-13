import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog } from "../src/components/Dialog.js";
import { accessibilityProblems } from "./accessibility.js";

/** A button that opens a small form in a dialog, as most dialogs here are opened. */
function RenameChannel({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Rename channel</button>
      {open && (
        <Dialog
          title="Rename channel"
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
        >
          <input aria-label="Channel name" autoFocus />
          <button>Save</button>
        </Dialog>
      )}
    </>
  );
}

describe("a dialog", () => {
  it("is announced as a modal dialog, named by its title", async () => {
    const user = userEvent.setup();
    render(<RenameChannel />);
    await user.click(screen.getByRole("button", { name: "Rename channel" }));
    const dialog = screen.getByRole("dialog", { name: "Rename channel" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(await accessibilityProblems(dialog)).toEqual([]);
  });

  it("takes focus when it opens, and gives it back to what opened it when it closes", async () => {
    const user = userEvent.setup();
    render(<RenameChannel />);
    const opener = screen.getByRole("button", { name: "Rename channel" });
    await user.click(opener);
    expect(screen.getByRole("textbox", { name: "Channel name" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("focuses itself when nothing inside asks for focus", () => {
    render(
      <Dialog title="Keyboard shortcuts" onClose={() => {}}>
        <p>Press ? to see this again.</p>
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toHaveFocus();
  });

  it("keeps Tab and Shift+Tab inside itself", async () => {
    const user = userEvent.setup();
    render(<RenameChannel />);
    await user.click(screen.getByRole("button", { name: "Rename channel" }));
    const close = screen.getByRole("button", { name: "Close" });
    const name = screen.getByRole("textbox", { name: "Channel name" });
    const save = screen.getByRole("button", { name: "Save" });

    await user.tab();
    expect(save).toHaveFocus();
    // Past the last control, round to the first rather than out to the page.
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(save).toHaveFocus();
    await user.tab({ shift: true });
    expect(name).toHaveFocus();
  });

  it("closes on Escape or a press outside it, but not on a press inside", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog title="Rename channel" onClose={onClose}>
        <p>Inside</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(screen.getByText("Inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <Dialog title="Rename channel" onClose={onClose}>
        <p>Inside</p>
      </Dialog>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("stays open while it has to", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog title="Stopping the workspace" onClose={onClose} dismissible={false}>
        <p>Stopping…</p>
      </Dialog>,
    );
    await user.keyboard("{Escape}");
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });
});
