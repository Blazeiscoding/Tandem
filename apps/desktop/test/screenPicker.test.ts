import { describe, expect, it, vi } from "vitest";
import { pickScreen, type ScreenPickerParts } from "../src/main/screenPicker.js";

/**
 * The desktop app's own screen picker (CALL-01). The renderer hears only
 * "nothing chosen", and must stay quiet for Cancel, so when there was nothing
 * to choose from the picker says so itself instead of looking like Cancel.
 */
type Screen = { name: string; id: string };
const screen = (id: string): Screen => ({ id, name: `Screen ${id}` });

function parts(screens: () => Promise<Screen[]>, response = 0) {
  const ask = vi.fn<ScreenPickerParts<Screen>["ask"]>().mockResolvedValue({ response });
  return { screens, ask };
}

describe("choosing a screen to share", () => {
  it("shares the screen chosen", async () => {
    const p = parts(async () => [screen("1"), screen("2")], 2);
    expect(await pickScreen(p)).toEqual(screen("2"));
    expect(p.ask).toHaveBeenCalledOnce();
    expect(p.ask.mock.calls[0]![0].buttons).toEqual(["Cancel", "Screen 1", "Screen 2"]);
  });

  it("shares nothing, and says nothing more, on Cancel", async () => {
    const p = parts(async () => [screen("1")], 0);
    expect(await pickScreen(p)).toBeNull();
    expect(p.ask).toHaveBeenCalledOnce();
  });

  it("says there is no screen to share, rather than looking like Cancel", async () => {
    const p = parts(async () => []);
    expect(await pickScreen(p)).toBeNull();
    expect(p.ask).toHaveBeenCalledOnce();
    expect(p.ask.mock.calls[0]![0]).toMatchObject({
      message: "There is no screen to share",
      buttons: ["OK"],
    });
  });

  it("says screen sharing could not start when the screens cannot be listed", async () => {
    const p = parts(() => Promise.reject(new Error("capturer failed")));
    expect(await pickScreen(p)).toBeNull();
    expect(p.ask.mock.calls[0]![0]).toMatchObject({
      type: "warning",
      message: "Screen sharing could not start",
    });
  });
});
