import { describe, expect, it } from "vitest";
import { hasSearchCriteria, parseSearchQuery } from "../src/search.js";

describe("parseSearchQuery", () => {
  it("keeps plain words as search terms", () => {
    const p = parseSearchQuery("quarterly zebra report");
    expect(p.terms).toEqual(["quarterly", "zebra", "report"]);
    expect(p.from).toEqual([]);
  });

  it("pulls out modifiers and leaves the rest as terms", () => {
    const p = parseSearchQuery("from:@alice in:#general has:link deploy notes");
    expect(p.from).toEqual(["alice"]);
    expect(p.in).toEqual(["general"]);
    expect(p.has).toEqual(["link"]);
    expect(p.terms).toEqual(["deploy", "notes"]);
  });

  it("accepts modifiers with or without the @ and # sigils", () => {
    expect(parseSearchQuery("from:alice in:general").from).toEqual(["alice"]);
    expect(parseSearchQuery("from:alice in:general").in).toEqual(["general"]);
  });

  it("is case-insensitive on the modifier name and value", () => {
    const p = parseSearchQuery("FROM:@Alice IN:#General");
    expect(p.from).toEqual(["alice"]);
    expect(p.in).toEqual(["general"]);
  });

  it("treats after: as exclusive of the named day and before: as up to it", () => {
    const p = parseSearchQuery("after:2026-01-01 before:2026-02-01");
    expect(new Date(p.after!).getDate()).toBe(2);
    expect(new Date(p.before!).getDate()).toBe(1);
    expect(new Date(p.before!).getMonth()).toBe(1);
  });

  it("ignores malformed dates and unknown has: values rather than failing", () => {
    const p = parseSearchQuery("before:yesterday has:banana");
    expect(p.before).toBeNull();
    expect(p.has).toEqual([]);
    // Neither becomes a free-text term — they were still modifier syntax.
    expect(p.terms).toEqual([]);
  });

  it("treats an empty modifier value as noise", () => {
    expect(parseSearchQuery("from:").from).toEqual([]);
    expect(hasSearchCriteria(parseSearchQuery("from:"))).toBe(false);
  });

  it("accepts several of the same modifier", () => {
    const p = parseSearchQuery("from:@alice from:@bob");
    expect(p.from).toEqual(["alice", "bob"]);
  });

  it("reports whether there is anything to search for", () => {
    expect(hasSearchCriteria(parseSearchQuery(""))).toBe(false);
    expect(hasSearchCriteria(parseSearchQuery("   "))).toBe(false);
    expect(hasSearchCriteria(parseSearchQuery("in:#general"))).toBe(true);
    expect(hasSearchCriteria(parseSearchQuery("hello"))).toBe(true);
  });
});
