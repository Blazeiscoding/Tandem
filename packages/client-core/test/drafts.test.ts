import { describe, expect, it } from "vitest";
import {
  applyDraftChanges,
  isDraftChanges,
  mergeDrafts,
  readStoredDrafts,
  unwrapStoredDrafts,
} from "../src/index.js";

/**
 * Drafts every window on one account writes. Each writes only the drafts it
 * changed, so the merge replaces each of those alone and leaves the rest.
 */
describe("merging one window's draft changes", () => {
  it("changes only the drafts named, whichever window wrote last", () => {
    let stored = mergeDrafts({}, { put: { C1: "first window" }, remove: [] });
    stored = mergeDrafts(stored, { put: { C2: "second window" }, remove: [] });
    expect(stored).toEqual({ C1: "first window", C2: "second window" });
    stored = mergeDrafts(stored, { put: {}, remove: ["C1"] });
    expect(stored).toEqual({ C2: "second window" });
  });

  it("brings across an earlier version's drafts only where there is none", () => {
    const stored = mergeDrafts(
      { C1: "written since" },
      { put: {}, remove: [], fill: { C1: "from before", C2: "only there" } },
    );
    expect(stored).toEqual({ C1: "written since", C2: "only there" });
  });
});

describe("reading stored drafts", () => {
  it("reads text by key, wrapped or not, and nothing as none", () => {
    expect(readStoredDrafts(null)).toEqual({});
    expect(readStoredDrafts({ C1: "a" })).toEqual({ C1: "a" });
    expect(unwrapStoredDrafts({ version: 1, value: { C1: "a" } }, true)).toEqual({ C1: "a" });
    // What an earlier version recorded for a key it found empty.
    expect(unwrapStoredDrafts({ version: 1, value: null }, true)).toEqual({});
  });

  it("refuses anything else", () => {
    expect(readStoredDrafts(["a"])).toBeNull();
    expect(readStoredDrafts({ C1: 3 })).toBeNull();
    expect(unwrapStoredDrafts({ C1: "a" }, true)).toBeNull();
    expect(isDraftChanges({ put: { C1: 1 }, remove: [] })).toBe(false);
    expect(isDraftChanges({ put: {}, remove: [3] })).toBe(false);
    expect(isDraftChanges({ put: {}, remove: [], fill: [] })).toBe(false);
    expect(isDraftChanges({ put: { C1: "a" }, remove: ["C2"] })).toBe(true);
  });

  it("replaces an unreadable value instead of refusing every later write", () => {
    const { value, drafts } = applyDraftChanges(
      { version: 1, value: "garbage" },
      { put: { C1: "kept" }, remove: [] },
      true,
    );
    expect(drafts).toEqual({ C1: "kept" });
    expect(value).toEqual({ version: 1, value: { C1: "kept" } });
  });
});
