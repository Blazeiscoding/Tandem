import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { PlatformContext } from "../src/context.js";
import type { Platform } from "../src/platform.js";
import { gainOf, useCallVolumes, WRITE_DELAY_MS } from "../src/lib/callVolumes.js";

/** A device whose storage holds `saved`, or reads it once `read` resolves. */
function device(saved: unknown = null, read?: Promise<unknown>) {
  const set = vi.fn(async (_key: string, _value: unknown) => {});
  const get = vi.fn(() => read ?? Promise.resolve(saved));
  const platform = {
    kind: "web",
    storage: { get, set },
    notify: () => {},
  } as unknown as Platform;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>
  );
  return { set, ...renderHook(() => useCallVolumes(), { wrapper }) };
}

afterEach(() => vi.useRealTimers());

describe("how loud each person in a call is to you", () => {
  it("is as they arrive until chosen, and is written once a drag rests", async () => {
    vi.useFakeTimers();
    const { result, set } = device();
    await act(async () => {});
    expect(result.current.volumes).toEqual({});
    act(() => {
      result.current.set("U_PRIYA", { volume: 120 });
      result.current.set("U_PRIYA", { volume: 150 });
    });
    expect(result.current.volumes).toEqual({ U_PRIYA: { volume: 150, muted: false } });
    expect(set).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(WRITE_DELAY_MS));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith("call-volumes", { U_PRIYA: { volume: 150, muted: false } });
  });

  it("keeps a muted person's volume for when they are not, and forgets anyone back as sent", async () => {
    const { result } = device();
    await act(async () => {});
    act(() => result.current.set("U_PRIYA", { volume: 150 }));
    act(() => result.current.set("U_PRIYA", { muted: true }));
    expect(result.current.volumes.U_PRIYA).toEqual({ volume: 150, muted: true });
    act(() => result.current.set("U_PRIYA", { muted: false }));
    expect(result.current.volumes.U_PRIYA).toEqual({ volume: 150, muted: false });
    act(() => result.current.set("U_PRIYA", { volume: 100 }));
    expect(result.current.volumes).toEqual({});
  });

  it("reads what was saved, leaving out what cannot be a volume", async () => {
    const { result } = device({
      A: { volume: 500 },
      B: { volume: "loud", muted: true },
      C: { volume: 100 },
      D: "quiet",
      E: { volume: 42.4, muted: "yes" },
    });
    await act(async () => {});
    expect(result.current.volumes).toEqual({
      A: { volume: 200, muted: false },
      B: { volume: 100, muted: true },
      E: { volume: 42, muted: false },
    });
  });

  it("does not let a change made while reading replace everyone else's", async () => {
    vi.useFakeTimers();
    let finish!: (saved: unknown) => void;
    const { result, set } = device(
      null,
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    act(() => result.current.set("A", { volume: 50 }));
    await act(() => vi.advanceTimersByTimeAsync(WRITE_DELAY_MS));
    // Written only once what was there is known.
    expect(set).not.toHaveBeenCalled();
    await act(async () => finish({ A: { volume: 180 }, B: { volume: 30 } }));
    expect(result.current.volumes).toEqual({
      A: { volume: 50, muted: false },
      B: { volume: 30, muted: false },
    });
    expect(set).toHaveBeenCalledWith("call-volumes", result.current.volumes);
  });

  it("is from silent to twice as loud as they arrive", () => {
    expect(gainOf(undefined)).toBe(1);
    expect(gainOf({ volume: 150, muted: false })).toBe(1.5);
    expect(gainOf({ volume: 150, muted: true })).toBe(0);
  });
});
