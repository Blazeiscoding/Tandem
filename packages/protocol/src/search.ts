/**
 * Search syntax shared by the server (which runs the query) and the client
 * (which shows what it understood). Everything that isn't a recognised
 * modifier becomes free text for full-text search.
 *
 *   from:@alice  in:#general  has:link  has:file  before:2026-01-31  after:2026-01-01
 */
export interface ParsedSearch {
  /** Words left over after modifiers are removed. */
  terms: string[];
  /** Handles, without the leading @. */
  from: string[];
  /** Channel names, without the leading #. */
  in: string[];
  has: ("link" | "file")[];
  /** Epoch ms bounds, inclusive of the whole named day. */
  before: number | null;
  after: number | null;
}

const MODIFIER = /^(from|in|has|before|after):(.*)$/i;

/** Midnight local time for a YYYY-MM-DD string, or null if unparseable. */
function parseDay(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function parseSearchQuery(raw: string): ParsedSearch {
  const result: ParsedSearch = {
    terms: [],
    from: [],
    in: [],
    has: [],
    before: null,
    after: null,
  };

  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const m = MODIFIER.exec(token);
    if (!m) {
      result.terms.push(token);
      continue;
    }
    const key = m[1]!.toLowerCase();
    const value = m[2]!;
    // A bare "from:" with nothing after it is just noise, not a filter.
    if (!value) continue;

    switch (key) {
      case "from":
        result.from.push(value.replace(/^@/, "").toLowerCase());
        break;
      case "in":
        result.in.push(value.replace(/^#/, "").toLowerCase());
        break;
      case "has":
        if (value.toLowerCase() === "link" || value.toLowerCase() === "file") {
          result.has.push(value.toLowerCase() as "link" | "file");
        }
        break;
      case "before": {
        const day = parseDay(value);
        if (day !== null) result.before = day;
        break;
      }
      case "after": {
        const day = parseDay(value);
        // Exclusive of the named day: "after:2026-01-01" means from the 2nd on.
        if (day !== null) result.after = day + 24 * 60 * 60 * 1000;
        break;
      }
    }
  }

  return result;
}

/** True when the query has something to act on. */
export function hasSearchCriteria(p: ParsedSearch): boolean {
  return (
    p.terms.length > 0 ||
    p.from.length > 0 ||
    p.in.length > 0 ||
    p.has.length > 0 ||
    p.before !== null ||
    p.after !== null
  );
}
