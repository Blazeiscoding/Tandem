/**
 * A small record of text values by name, kept on the device for every window
 * open on it: what each account chose for its notifications, for instance.
 *
 * Each window writes only the names it changed, never a whole record read
 * earlier, so one window's choice for one account cannot erase another's
 * choice for another account (F02). Kept free of anything but plain data so
 * the desktop app's main process can run the same merge for every window.
 */
export type RecordChanges = Record<string, string | null>;

/** Most names one change may carry, and the longest name or value. */
const MAX_NAMES = 64;
const MAX_LENGTH = 1024;

/** Whether `value` is a change this merge accepts: text, or null to remove. */
export function isRecordChanges(value: unknown): value is RecordChanges {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_NAMES &&
    entries.every(
      ([name, text]) =>
        name.length <= MAX_LENGTH &&
        (text === null || (typeof text === "string" && text.length <= MAX_LENGTH)),
    )
  );
}

/**
 * The record a stored value holds, or null when it is not one: something
 * that is not an object, or any value that is not text. A caller decides
 * what an unreadable record means; for a privacy choice, the private one.
 */
export function readStoredRecord(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const record: Record<string, string> = {};
  for (const [name, text] of Object.entries(value)) {
    if (typeof text !== "string") return null;
    record[name] = text;
  }
  return record;
}

/**
 * Applies one window's changes to what is stored. Every other name keeps its
 * text, even beside a damaged value, which goes: one bad entry must not take
 * the others with it. A stored value that is not a record at all is replaced.
 */
export function applyRecordChanges(
  stored: unknown,
  changes: RecordChanges,
): Record<string, string> {
  const next: Record<string, string> = {};
  if (stored && typeof stored === "object" && !Array.isArray(stored))
    for (const [name, text] of Object.entries(stored))
      if (typeof text === "string") next[name] = text;
  for (const [name, text] of Object.entries(changes)) {
    if (text === null) delete next[name];
    else next[name] = text;
  }
  return next;
}
