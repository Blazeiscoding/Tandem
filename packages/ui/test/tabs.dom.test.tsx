import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useTabs, type TabChoice } from "../src/lib/useTabs.js";
import { accessibilityProblems } from "./accessibility.js";

const SEASONS = ["spring", "summer", "autumn"] as const;
type Season = (typeof SEASONS)[number];

function Seasons(props: { onSelect?: (tab: Season, how: TabChoice) => void }) {
  const [season, setSeason] = useState<Season>("spring");
  const tabs = useTabs({
    label: "Seasons",
    tabs: SEASONS,
    selected: season,
    onSelect(tab, how) {
      props.onSelect?.(tab, how);
      setSeason(tab);
    },
  });
  return (
    <main>
      <div {...tabs.listProps}>
        {SEASONS.map((s) => (
          <button key={s} {...tabs.tabProps(s)}>
            {s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      <div {...tabs.panelProps}>
        <p>About {season}</p>
        <button>Plant something</button>
      </div>
    </main>
  );
}

function setup(onSelect?: (tab: Season, how: TabChoice) => void) {
  const user = userEvent.setup();
  render(<Seasons onSelect={onSelect} />);
  const list = screen.getByRole("tablist", { name: "Seasons" });
  const tab = (name: string) => within(list).getByRole("tab", { name });
  return { user, list, tab };
}

describe("a row of tabs", () => {
  it("is a named tablist with one selected tab, one Tab stop and a panel named by that tab", async () => {
    const { user, list, tab } = setup();
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    const panel = screen.getByRole("tabpanel", { name: "Spring" });
    for (const t of tabs) expect(t).toHaveAttribute("aria-controls", panel.id);
    expect(await accessibilityProblems()).toEqual([]);

    // Tab goes from the selected tab straight into the panel, past the others.
    await user.tab();
    expect(tab("Spring")).toHaveFocus();
    await user.tab();
    expect(within(panel).getByRole("button", { name: "Plant something" })).toHaveFocus();
  });

  it("moves with Left and Right, wrapping at both ends, and selection follows", async () => {
    const onSelect = vi.fn();
    const { user, tab } = setup(onSelect);
    tab("Spring").focus();
    await user.keyboard("{ArrowRight}");
    expect(tab("Summer")).toHaveFocus();
    expect(tab("Summer")).toHaveAttribute("aria-selected", "true");
    expect(tab("Summer")).toHaveAttribute("tabindex", "0");
    expect(tab("Spring")).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel", { name: "Summer" })).toHaveTextContent("About summer");
    expect(onSelect).toHaveBeenLastCalledWith("summer", "key");

    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(tab("Spring")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(tab("Autumn")).toHaveFocus();
    expect(tab("Autumn")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Autumn" })).toBeVisible();
  });

  it("goes to the ends with Home and End, and tells nobody when the tab stays the same", async () => {
    const onSelect = vi.fn();
    const { user, tab } = setup(onSelect);
    tab("Spring").focus();
    await user.keyboard("{End}");
    expect(tab("Autumn")).toHaveFocus();
    expect(tab("Autumn")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(tab("Spring")).toHaveFocus();
    expect(tab("Spring")).toHaveAttribute("aria-selected", "true");
    expect(onSelect.mock.calls).toEqual([
      ["autumn", "key"],
      ["spring", "key"],
    ]);
    await user.keyboard("{Home}");
    await user.click(tab("Spring"));
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("selects a clicked tab, and says it was a click", async () => {
    const onSelect = vi.fn();
    const { user, tab } = setup(onSelect);
    await user.click(tab("Autumn"));
    expect(tab("Autumn")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Autumn" })).toBeVisible();
    expect(onSelect).toHaveBeenCalledWith("autumn", "click");
  });

  it("leaves keys held with Alt, Ctrl or Meta to others, such as Alt+Left for Back", () => {
    const { tab } = setup();
    tab("Spring").focus();
    for (const modifier of ["altKey", "ctrlKey", "metaKey"]) {
      const handled = !fireEvent.keyDown(tab("Spring"), { key: "ArrowRight", [modifier]: true });
      expect(handled).toBe(false);
      expect(tab("Spring")).toHaveAttribute("aria-selected", "true");
      expect(tab("Spring")).toHaveFocus();
    }
    // Keys a tab has no use for are not taken either.
    expect(fireEvent.keyDown(tab("Spring"), { key: "ArrowDown" })).toBe(true);
  });
});
