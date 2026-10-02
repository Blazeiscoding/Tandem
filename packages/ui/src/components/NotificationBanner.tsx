import { useEffect, useState } from "react";
import type { Platform } from "../platform.js";

/** How long "Not now" keeps the banner away on this device. */
export const NOTIFICATION_PROMPT_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
const SNOOZED_AT = "notificationPromptSnoozedAt";

/** What the browser currently allows, or that it cannot ask at all. */
function current(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/**
 * Asked after signing in, instead of on the first click anywhere (which was
 * usually the Sign in button). Browsers only prompt from a visible gesture.
 * "Not now" keeps the banner away on this device for two weeks, rather than
 * until the next reload, and a refusal in the browser's own prompt stays
 * silent until the reader changes it in the browser's site settings. The
 * desktop app grants notifications itself, so it never shows this.
 */
export function NotificationBanner({
  storage,
  now = Date.now,
}: {
  storage: Platform["storage"];
  now?: () => number;
}) {
  const [permission, setPermission] = useState(current);
  // Unknown until storage answers, so a snoozed banner does not flash first.
  const [snoozed, setSnoozed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (permission !== "default") return;
    let alive = true;
    storage
      .get<number>(SNOOZED_AT)
      .then((at) => typeof at === "number" && now() - at < NOTIFICATION_PROMPT_SNOOZE_MS)
      .catch(() => false)
      .then((value) => {
        if (alive) setSnoozed(value);
      });
    return () => {
      alive = false;
    };
  }, [storage, now, permission]);

  if (permission !== "default" || snoozed !== false) return null;

  async function enable() {
    if (busy) return;
    setBusy(true);
    try {
      setPermission(await Notification.requestPermission());
    } finally {
      setBusy(false);
    }
  }

  function snooze() {
    setSnoozed(true);
    // Remembering is a courtesy: if it cannot be saved, the banner is still gone.
    storage.set(SNOOZED_AT, now()).catch(() => {});
  }

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="flex shrink-0 items-center gap-3 border-b border-edge bg-raised px-4 py-2 text-sm text-ink"
    >
      <span className="min-w-0 flex-1 text-ink-dim">
        Turn on notifications to hear about mentions while Tandem is in the background.
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void enable()}
        className="shrink-0 font-medium text-copper hover:underline disabled:opacity-40"
      >
        {busy ? "Turning on…" : "Turn on"}
      </button>
      <button
        type="button"
        onClick={snooze}
        className="shrink-0 text-ink-dim hover:text-ink hover:underline"
      >
        Not now
      </button>
    </div>
  );
}
