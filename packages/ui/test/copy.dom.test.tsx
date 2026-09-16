import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCopy } from "../src/lib/useCopy.js";
import { copyBySelection, withoutClipboardApi } from "./clipboard.js";

const LINK = "http://192.168.1.20:8543/#/join/ABCD1234";
const undo: Array<() => void> = [];

function CopyButton({ text }: { text: string }) {
  const { copy, label } = useCopy();
  return (
    <button type="button" onClick={() => void copy(text)}>
      {label("Copy link", "Copied", "Copy failed")}
    </button>
  );
}

afterEach(() => {
  for (const step of undo.splice(0).reverse()) step();
  vi.restoreAllMocks();
});

describe("copying", () => {
  it("copies on a page given no Clipboard API, as one served over plain http is", async () => {
    const user = userEvent.setup();
    undo.push(withoutClipboardApi());
    const selection = copyBySelection();
    undo.push(selection.restore);
    render(<CopyButton text={LINK} />);
    const button = screen.getByRole("button", { name: "Copy link" });

    await user.click(button);
    expect(selection.copied).toEqual([LINK]);
    expect(button).toHaveTextContent("Copied");
    // Nothing is left behind, and the reader is where they were.
    expect(document.querySelector("textarea")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("copies the older way when the Clipboard API refuses", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new DOMException("Document is not focused.", "NotAllowedError"));
    const selection = copyBySelection();
    undo.push(selection.restore);
    render(<CopyButton text={LINK} />);

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(selection.copied).toEqual([LINK]);
    expect(screen.getByRole("button")).toHaveTextContent("Copied");
  });

  it("says the copy failed when neither way copies", async () => {
    const user = userEvent.setup();
    undo.push(withoutClipboardApi());
    render(<CopyButton text={LINK} />);
    const button = screen.getByRole("button", { name: "Copy link" });

    // A browser with neither way,
    await user.click(button);
    expect(button).toHaveTextContent("Copy failed");

    // and one whose older way declines.
    const selection = copyBySelection({ result: false });
    undo.push(selection.restore);
    await user.click(button);
    expect(selection.copied).toEqual([LINK]);
    expect(button).toHaveTextContent("Copy failed");
    expect(document.querySelector("textarea")).toBeNull();
    expect(button).toHaveFocus();
  });
});
