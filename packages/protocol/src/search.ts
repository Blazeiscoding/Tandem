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
  /**
   * Epoch ms bounds, as Slack reads them: `before:` excludes the named day and
   * everything after it, `after:` excludes the named day and everything before.
   * `before` is where the named day starts and `after` where the next one does,
   * both in the reader's time zone.
   */
  before: number | null;
  after: number | null;
  /** The days as named, YYYY-MM-DD, for saying back what was understood. */
  beforeDay: string | null;
  afterDay: string | null;
  /** `before:` and `after:` tokens whose value is not a real calendar date. */
  invalid: string[];
}

export interface SearchQueryOptions {
  /**
   * The IANA zone whose calendar days `before:` and `after:` name. The reader's
   * own, carried to the server with the query; without one, this process's.
   */
  timeZone?: string;
}

const MODIFIER = /^(from|in|has|before|after):(.*)$/i;

/** A real calendar date written YYYY-MM-DD, or null. */
function calendarDay(value: string): [year: number, month: number, day: number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Date quietly turns 31 February into 3 March. A date that does not come
  // back as it was written was never a date.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  )
    return null;
  return [year, month, day];
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** True when `timeZone` is a zone this runtime knows, such as "Europe/Paris". */
export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The calendar day an instant falls on in a zone, as the number yyyymmdd. */
function dayNumberAt(instant: number, timeZone: string): number {
  let year = 0;
  let month = 0;
  let day = 0;
  for (const part of formatter(timeZone).formatToParts(instant)) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
  }
  return year * 10_000 + month * 100 + day;
}

const HOUR = 3_600_000;

/**
 * The first instant of a calendar day in a zone. Found by searching rather
 * than by adding hours, because a day is not always 24 of them: one that
 * starts or ends a daylight-saving change is 23 or 25, and in a zone that
 * changes at midnight the day does not begin at 00:00 at all.
 */
function startOfDay([year, month, day]: [number, number, number], timeZone: string): number {
  const target = year * 10_000 + month * 100 + day;
  const utcMidnight = Date.UTC(year, month - 1, day);
  // Every zone is within UTC-12 and UTC+14, so the day starts in this window.
  let before = utcMidnight - 15 * HOUR;
  let atOrAfter = utcMidnight + 13 * HOUR;
  while (atOrAfter - before > 1) {
    const middle = Math.floor((before + atOrAfter) / 2);
    if (dayNumberAt(middle, timeZone) >= target) atOrAfter = middle;
    else before = middle;
  }
  return atOrAfter;
}

/** The calendar day after this one. */
function nextDay([year, month, day]: [number, number, number]): [number, number, number] {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
}

const dayText = ([year, month, day]: [number, number, number]) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

export function parseSearchQuery(raw: string, options: SearchQueryOptions = {}): ParsedSearch {
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const result: ParsedSearch = {
    terms: [],
    from: [],
    in: [],
    has: [],
    before: null,
    after: null,
    beforeDay: null,
    afterDay: null,
    invalid: [],
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
        const day = calendarDay(value);
        if (!day) {
          result.invalid.push(token);
          break;
        }
        result.before = startOfDay(day, timeZone);
        result.beforeDay = dayText(day);
        break;
      }
      case "after": {
        const day = calendarDay(value);
        if (!day) {
          result.invalid.push(token);
          break;
        }
        // Exclusive of the named day: "after:2026-01-01" means from the 2nd on,
        // from wherever the 2nd starts, which is not always 24 hours later.
        result.after = startOfDay(nextDay(day), timeZone);
        result.afterDay = dayText(day);
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
