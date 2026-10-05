import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, buttonClass } from "../src/components/Button.js";

describe("the shared button", () => {
  it("says what kind of action it is through its variant, and keeps layout classes", () => {
    expect(buttonClass("primary")).toContain("bg-copper");
    expect(buttonClass("danger")).toContain("bg-alert");
    expect(buttonClass("secondary")).toContain("border-[var(--card-edge-hover)]");
    expect(buttonClass("quiet")).not.toContain("border");
    // chaicode.com's asymmetric corners mark an action; a quiet one has none.
    for (const variant of ["primary", "secondary", "danger"] as const)
      expect(buttonClass(variant)).toContain("btn-shape");
    expect(buttonClass("quiet")).not.toContain("btn-shape");
    expect(buttonClass("primary", "w-full")).toBe(`${buttonClass("primary")} w-full`);
    for (const variant of ["primary", "secondary", "danger", "quiet"] as const)
      expect(buttonClass(variant)).toContain("disabled:opacity-40");
  });

  it("passes its props and ref through, and still submits the form it is in", async () => {
    const submit = vi.fn((event: SubmitEvent) => event.preventDefault());
    const ref = createRef<HTMLButtonElement>();
    render(
      <form onSubmit={(event) => submit(event.nativeEvent as SubmitEvent)}>
        <Button variant="primary" className="w-full" ref={ref} aria-describedby="hint">
          Save
        </Button>
        <p id="hint">Saved on this device</p>
      </form>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(ref.current).toBe(button);
    expect(button).toHaveClass("bg-copper", "w-full");
    expect(button).toHaveAccessibleDescription("Saved on this device");
    await userEvent.setup().click(button);
    expect(submit).toHaveBeenCalledOnce();
  });

  it("is the only place its styles are written", () => {
    // The DOM environment has no file URL for this module; tests run from the package.
    const root = join(process.cwd(), "src");
    const copies = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".tsx") && !file.endsWith("Button.tsx"))
      .filter((file) => {
        const text = readFileSync(join(root, file), "utf8");
        return (
          text.includes("bg-copper px-4 py-2.5 text-sm font-semibold") ||
          text.includes("bg-alert px-4 py-2.5 text-sm font-semibold")
        );
      });
    expect(copies).toEqual([]);
  });
});
