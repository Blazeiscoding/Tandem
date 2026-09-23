import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ListStatus } from "../src/components/ListStatus.js";
import { accessibilityProblems } from "./accessibility.js";

/** A list whose next load the test decides, the way a panel drives its status. */
function Harness(props: { startFailed?: boolean; emptyAction?: boolean }) {
  const [state, setState] = useState<"failed" | "loading" | "empty" | "loaded">(
    props.startFailed ? "failed" : "loading",
  );
  const [filtered, setFiltered] = useState(true);
  return (
    <section aria-label="Replies">
      <button type="button" onClick={() => setState("empty")}>
        Finish empty
      </button>
      <button type="button" onClick={() => setState("loaded")}>
        Finish with replies
      </button>
      <ListStatus
        loading={state === "loading"}
        placeholder
        loadingLabel="Loading replies…"
        error={state === "failed" ? "Could not load replies." : null}
        onRetry={() => setState("loading")}
        empty={state === "empty" ? (filtered ? "No unread replies." : "No replies yet.") : null}
        emptyAction={
          props.emptyAction && filtered
            ? { label: "Show all replies", run: () => setFiltered(false) }
            : undefined
        }
      />
      {state === "loaded" && <p>First reply</p>}
    </section>
  );
}

describe("a list's status", () => {
  it("stands in rows for what is coming, and says what is loading", async () => {
    render(<ListStatus loading placeholder loadingLabel="Loading replies…" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading replies…");
    // The rows are shapes only; the words are what a screen reader hears.
    expect(status.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
    expect(await accessibilityProblems(document.body)).toEqual([]);
  });

  it("keeps what is showing and says in one line what is refreshing", () => {
    render(
      <>
        <ListStatus loading loadingLabel="Loading messages…" />
        <p>An earlier page</p>
      </>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading messages…");
    expect(screen.getByRole("status").querySelector('[aria-hidden="true"].size-3')).not.toBeNull();
    expect(screen.getByText("An earlier page")).toBeVisible();
  });

  it("says each change in the same region, so a screen reader is already listening", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading replies…");

    await user.click(screen.getByRole("button", { name: "Finish empty" }));
    // The same element, not a new region appearing with the words already in it.
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("No unread replies.");

    await user.click(screen.getByRole("button", { name: "Finish with replies" }));
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toBeEmptyDOMElement();
  });

  it("reports a failure with Retry, and waits rather than retrying twice", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const { rerender } = render(
      <ListStatus
        loadingLabel="Loading replies…"
        error="Could not load replies."
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load replies. Retry");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();

    rerender(
      <ListStatus
        loading
        loadingLabel="Loading replies…"
        error="Could not load replies."
        onRetry={retry}
      />,
    );
    const waiting = screen.getByRole("button", { name: "Retry" });
    expect(waiting).toHaveAttribute("aria-disabled", "true");
    await user.click(waiting);
    expect(retry).toHaveBeenCalledOnce();
    expect(await accessibilityProblems(document.body)).toEqual([]);
  });

  it("keeps focus with the list when Retry gives way to the load it started", async () => {
    const user = userEvent.setup();
    render(<Harness startFailed />);
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Focus stays where the list says what it is doing, not on the page.
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("status").parentElement).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Loading replies…");
  });

  it("offers one thing to do about an empty list, and keeps focus when it is done", async () => {
    const user = userEvent.setup();
    render(<Harness emptyAction />);
    await user.click(screen.getByRole("button", { name: "Finish empty" }));
    const showAll = screen.getByRole("button", { name: "Show all replies" });
    expect(await accessibilityProblems(document.body)).toEqual([]);

    act(() => showAll.focus());
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("No replies yet.");
    expect(screen.queryByRole("button", { name: "Show all replies" })).not.toBeInTheDocument();
    expect(screen.getByRole("status").parentElement).toHaveFocus();
  });

  it("says nothing and takes no room while the list simply has its content", () => {
    render(<ListStatus loadingLabel="Loading replies…" />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
