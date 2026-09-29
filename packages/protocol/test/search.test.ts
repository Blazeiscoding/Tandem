import { describe, expect, it } from "vitest";
import { hasSearchCriteria, isTimeZone, parseSearchQuery } from "../src/search.js";

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

  it("ignores unknown has: values, and names a date it cannot read rather than dropping it", () => {
    const p = parseSearchQuery("before:yesterday has:banana");
    expect(p.before).toBeNull();
    expect(p.has).toEqual([]);
    expect(p.invalid).toEqual(["before:yesterday"]);
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

describe("dates in a search", () => {
  const inZone = (query: string, timeZone: string) => parseSearchQuery(query, { timeZone });

  it("starts the day after a spring-forward day where that day starts, not 24 hours on", () => {
    // New York moves to daylight time on 8 March 2026; the 9th starts at 04:00 UTC.
    const p = inZone("after:2026-03-08 before:2026-03-08", "America/New_York");
    expect(p.after).toBe(Date.UTC(2026, 2, 9, 4));
    expect(p.before).toBe(Date.UTC(2026, 2, 8, 5));
  });

  it("does not let a fall-back day's extra hour leak into the next", () => {
    // 1 November 2026 has 25 hours in New York; the 2nd starts at 05:00 UTC.
    const p = inZone("after:2026-11-01 before:2026-11-01", "America/New_York");
    expect(p.after).toBe(Date.UTC(2026, 10, 2, 5));
    expect(p.before).toBe(Date.UTC(2026, 10, 1, 4));
  });

  it("starts a day that has no midnight at its first real instant", () => {
    // Havana and Santiago move their clocks forward at midnight.
    expect(inZone("before:2026-03-08", "America/Havana").before).toBe(Date.UTC(2026, 2, 8, 5));
    expect(inZone("before:2026-09-06", "America/Santiago").before).toBe(Date.UTC(2026, 8, 6, 4));
  });

  it("names the reader's days across the whole range of offsets", () => {
    expect(inZone("before:2026-01-15", "Asia/Kolkata").before).toBe(Date.UTC(2026, 0, 14, 18, 30));
    expect(inZone("before:2026-01-15", "Pacific/Kiritimati").before).toBe(
      Date.UTC(2026, 0, 14, 10),
    );
    expect(inZone("before:2026-01-15", "Pacific/Pago_Pago").before).toBe(Date.UTC(2026, 0, 15, 11));
    expect(inZone("before:2026-01-15", "UTC").before).toBe(Date.UTC(2026, 0, 15));
  });

  it("gives the same bounds whatever zone the process itself runs in", () => {
    const original = process.env.TZ;
    try {
      const bounds = ["Asia/Tokyo", "America/Los_Angeles", "UTC"].map((zone) => {
        process.env.TZ = zone;
        const p = inZone("after:2026-03-08 before:2026-11-01", "America/New_York");
        return [p.after, p.before];
      });
      expect(new Set(bounds.map((b) => b.join()))).toHaveProperty("size", 1);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("accepts a leap day only in a leap year, and refuses days that do not exist", () => {
    expect(inZone("after:2028-02-29", "UTC").after).toBe(Date.UTC(2028, 2, 1));
    const p = inZone(
      "after:2026-02-29 before:2026-02-31 after:2026-13-01 before:2026-00-10 after:0099-01-01",
      "UTC",
    );
    expect(p.after).toBeNull();
    expect(p.before).toBeNull();
    expect(p.invalid).toEqual([
      "after:2026-02-29",
      "before:2026-02-31",
      "after:2026-13-01",
      "before:2026-00-10",
      "after:0099-01-01",
    ]);
  });

  it("says back the days as they were named", () => {
    const p = inZone("after:2026-01-31 before:2026-03-01", "Asia/Kolkata");
    expect([p.afterDay, p.beforeDay]).toEqual(["2026-01-31", "2026-03-01"]);
  });

  it("knows a time zone from a made-up one", () => {
    expect(isTimeZone("Europe/Paris")).toBe(true);
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
  });
});
