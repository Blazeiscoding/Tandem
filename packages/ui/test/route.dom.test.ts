import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderHook, waitFor } from "@testing-library/react";
import { useHistoryKeys } from "../src/lib/historyKeys.js";
import { currentRoute, parseRouteHash, routeHash, writeRoute } from "../src/lib/route.js";

describe("reading a place in a workspace from the address", () => {
  it("reads a conversation, and a thread open beside it", () => {
    expect(parseRouteHash("#/c/C_DESIGN")).toEqual({ channelId: "C_DESIGN", threadRootId: null });
    expect(parseRouteHash("#/c/C_DESIGN/t/M_ROOT")).toEqual({
      channelId: "C_DESIGN",
      threadRootId: "M_ROOT",
    });
    expect(routeHash({ channelId: "C_DESIGN", threadRootId: "M_ROOT" })).toBe(
      "#/c/C_DESIGN/t/M_ROOT",
    );
  });

  it("leaves links to a message, and anything else, alone", () => {
    for (const hash of ["", "#", "#/join/ABCD", "#/c/C_DESIGN/m/M_PLAN", "#/c/", "#/c/a%2Fb"]) {
      expect(parseRouteHash(hash)).toBeNull();
    }
  });
});

describe("the place a history entry remembers", () => {
  const here = () => location.origin;
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("belongs to one workspace, whatever the address says", () => {
    const state = {
      gatherline: { server: "http://10.0.0.5:8543", channelId: "C_OPS", threadRootId: null },
    };
    const address = { hash: "#/c/C_DESIGN", origin: here() };
    expect(currentRoute("http://10.0.0.5:8543", address, state)).toEqual({
      channelId: "C_OPS",
      threadRootId: null,
    });
    // Another workspace's entry, in a desktop app with more than one.
    expect(currentRoute("http://10.0.0.9:8543", address, state)).toBeNull();
  });

  it("reads a typed or shared address only on the page the workspace serves", () => {
    const address = { hash: "#/c/C_DESIGN/t/M_ROOT", origin: here() };
    expect(currentRoute(here(), address, null)).toEqual({
      channelId: "C_DESIGN",
      threadRootId: "M_ROOT",
    });
    expect(currentRoute("http://10.0.0.5:8543", address, null)).toBeNull();
  });

  it("replaces the entry it arrived on, then adds one for each move, and Back returns", async () => {
    const server = here();
    const start = window.history.length;
    writeRoute(server, { channelId: "C_GENERAL", threadRootId: null });
    expect(window.history.length).toBe(start);
    expect(location.hash).toBe("#/c/C_GENERAL");

    writeRoute(server, { channelId: "C_DESIGN", threadRootId: null });
    writeRoute(server, { channelId: "C_DESIGN", threadRootId: "M_ROOT" });
    // The same place again is not a move.
    writeRoute(server, { channelId: "C_DESIGN", threadRootId: "M_ROOT" });
    expect(window.history.length).toBe(start + 2);
    expect(location.hash).toBe("#/c/C_DESIGN/t/M_ROOT");

    window.history.back();
    await waitFor(() =>
      expect(currentRoute(server)).toEqual({ channelId: "C_DESIGN", threadRootId: null }),
    );
    expect(location.hash).toBe("#/c/C_DESIGN");
  });

  it("replaces rather than adds when the app moved on its own, or the entry is another workspace's", () => {
    const server = here();
    writeRoute("http://10.0.0.9:8543", { channelId: "C_OTHER", threadRootId: null });
    const start = window.history.length;
    writeRoute(server, { channelId: "C_GENERAL", threadRootId: null });
    writeRoute(server, { channelId: "C_GONE", threadRootId: null }, "replace");
    expect(window.history.length).toBe(start);
    expect(currentRoute(server)).toEqual({ channelId: "C_GONE", threadRootId: null });
  });
});

describe("Back and Forward in a window without a toolbar", () => {
  afterEach(() => vi.restoreAllMocks());

  it("follows Alt with the arrow keys, and the mouse's side buttons, only when switched on", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const forward = vi.spyOn(window.history, "forward").mockImplementation(() => {});
    const { rerender, unmount } = renderHook(({ on }) => useHistoryKeys(on), {
      initialProps: { on: false },
    });
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    expect(back).not.toHaveBeenCalled();

    rerender({ on: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    fireEvent.mouseUp(window, { button: 3 });
    fireEvent.mouseUp(window, { button: 4 });
    // Word-by-word selection and other editing keys are left alone.
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", ctrlKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(back).toHaveBeenCalledTimes(2);
    expect(forward).toHaveBeenCalledTimes(2);

    unmount();
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    expect(back).toHaveBeenCalledTimes(2);
  });
});
