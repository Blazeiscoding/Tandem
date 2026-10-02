import { describe, expect, it } from "vitest";
import {
  RENDERER_RECOVERY,
  RendererRecovery,
  isRendererLoadFailure,
} from "../src/main/rendererRecovery.js";

/** When the window's page dies or fails to load (REV-09). */
describe("recovering the window's page", () => {
  it("reloads a few times, then asks instead of reloading forever", () => {
    let now = 0;
    const recovery = new RendererRecovery(RENDERER_RECOVERY, () => now);
    const steps = Array.from({ length: 5 }, () => {
      now += 1_000;
      return recovery.failed();
    });
    expect(steps).toEqual(["reload", "reload", "reload", "ask", "ask"]);
  });

  it("counts only recent failures, so a page that fails now and then always comes back", () => {
    let now = 0;
    const recovery = new RendererRecovery(RENDERER_RECOVERY, () => now);
    for (let i = 0; i < 20; i++) {
      now += RENDERER_RECOVERY.windowMs / 2;
      expect(recovery.failed()).toBe("reload");
    }
  });

  it("starts counting again when someone chooses to try again", () => {
    let now = 0;
    const recovery = new RendererRecovery(RENDERER_RECOVERY, () => now);
    for (let i = 0; i < 4; i++) recovery.failed();
    expect(recovery.failed()).toBe("ask");
    recovery.reset();
    expect(recovery.failed()).toBe("reload");
  });

  it("recovers from the page failing to load, not from a frame or a replaced navigation", () => {
    expect(isRendererLoadFailure(-6, true)).toBe(true); // ERR_FILE_NOT_FOUND
    expect(isRendererLoadFailure(-102, true)).toBe(true); // ERR_CONNECTION_REFUSED (dev server)
    expect(isRendererLoadFailure(-3, true)).toBe(false); // ERR_ABORTED
    expect(isRendererLoadFailure(-6, false)).toBe(false);
  });
});
