/** Preset times offered when scheduling a message. */
export interface SchedulePreset {
  label: string;
  at: Date;
}

/** Next occurrence of `hour` on the given day offset, at minute 0. */
function at(hour: number, dayOffset = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/**
 * Presets relative to now: a short delay, later today if there's still day
 * left, then tomorrow and the start of next week.
 */
export function schedulePresets(now = new Date()): SchedulePreset[] {
  const out: SchedulePreset[] = [
    { label: "In 30 minutes", at: new Date(now.getTime() + 30 * 60_000) },
    { label: "In an hour", at: new Date(now.getTime() + 60 * 60_000) },
  ];

  // "This evening" is only meaningful while it is still ahead.
  const evening = at(18);
  if (evening.getTime() > now.getTime() + 60 * 60_000) {
    out.push({ label: "This evening", at: evening });
  }

  out.push({ label: "Tomorrow morning", at: at(9, 1) });

  // Monday, skipping to next week if today is already Monday.
  const monday = at(9, ((8 - now.getDay()) % 7) || 7);
  out.push({ label: "Monday morning", at: monday });

  return out;
}

/** "Tomorrow at 9:00 AM" — how a scheduled time reads in the UI. */
export function formatScheduleTime(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `Today at ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow at ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })} at ${time}`;
}
