import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Menu, type MenuItem } from "../src/components/Menu.js";
import { accessibilityProblems } from "./accessibility.js";

function actions(): { items: MenuItem[]; selected: (id: string) => void; calls: string[] } {
  const calls: string[] = [];
  const selected = (id: string) => calls.push(id);
  return {
    calls,
    selected,
    items: [
      { id: "promote", label: "Make admin", onSelect: () => selected("promote") },
      { id: "invite", label: "Allow inviting", disabled: true, onSelect: () => selected("invite") },
      {
        id: "deactivate",
        label: "Deactivate",
        destructive: true,
        onSelect: () => selected("deactivate"),
      },
    ],
  };
}

describe("a menu", () => {
  it("opens from its trigger as a named menu, with no automated accessibility problems", async () => {
    const { items } = actions();
    const user = userEvent.setup();
    render(<Menu label="Actions for Sam Rivera" items={items} />);
    await user.click(screen.getByRole("button", { name: "Actions for Sam Rivera" }));

    const menu = screen.getByRole("menu", { name: "Actions for Sam Rivera" });
    expect(menu).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Make admin" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Deactivate" })).toBeVisible();
    expect(await accessibilityProblems(menu)).toEqual([]);
  });

  it("moves with arrows past disabled items, and Enter chooses and returns focus", async () => {
    const { items, calls } = actions();
    const user = userEvent.setup();
    render(<Menu label="Actions for Sam Rivera" items={items} />);
    const trigger = screen.getByRole("button", { name: "Actions for Sam Rivera" });
    await user.click(trigger);

    // The disabled item is skipped: one step down lands on Deactivate.
    expect(screen.getByRole("menuitem", { name: "Make admin" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Deactivate" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Make admin" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Deactivate" })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(calls).toEqual(["deactivate"]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("chooses on click, and closes on Escape with focus back on the trigger", async () => {
    const { items, calls } = actions();
    const user = userEvent.setup();
    render(<Menu label="Actions for Sam Rivera" items={items} />);
    const trigger = screen.getByRole("button", { name: "Actions for Sam Rivera" });

    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Make admin" }));
    expect(calls).toEqual(["promote"]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(calls).toEqual(["promote"]);
  });

  it("leaves on Tab rather than trapping it, with focus back where it started", async () => {
    const { items, calls } = actions();
    const user = userEvent.setup();
    render(<Menu label="Actions for Sam Rivera" items={items} />);
    const trigger = screen.getByRole("button", { name: "Actions for Sam Rivera" });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeVisible();

    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(calls).toEqual([]);
  });

  it("stays open when something else on the page scrolls, following its trigger", async () => {
    const { items } = actions();
    const user = userEvent.setup();
    render(
      <div>
        <div data-testid="timeline" style={{ overflowY: "auto" }}>
          <Menu label="Actions for Sam Rivera" items={items} />
        </div>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "Actions for Sam Rivera" }));
    expect(screen.getByRole("menu")).toBeVisible();

    // A live timeline settling under an open menu must not take the menu.
    fireEvent.scroll(document);
    fireEvent.scroll(screen.getByTestId("timeline"));
    window.dispatchEvent(new Event("resize"));
    expect(screen.getByRole("menu")).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Make admin" })).toBeVisible();
  });
});
