import { useState } from "react";

/** What the browser currently allows, or that it cannot ask at all. */
function current(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/**
 * Asked once, after signing in, instead of on the first click anywhere
 * (which was usually the Sign in button). Browsers only prompt from a
 * visible gesture; a dismissal here waits for the next sign-in, while a
 * refusal in the browser's own prompt stays silent until the reader changes
 * it in the browser's site settings.
 */
export function NotificationBanner() {
  const [permission, setPermission] = useState(current);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (permission !== "default" || dismissed) return null;

  async function enable() {
    if (busy) return;
    setBusy(true);
    try {
      setPermission(await Notification.requestPermission());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="flex shrink-0 items-center gap-3 border-b border-edge bg-raised px-4 py-2 text-sm text-ink"
    >
      <span className="min-w-0 flex-1 text-ink-dim">
        Turn on notifications to hear about mentions while Gatherline is in the background.
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
        onClick={() => setDismissed(true)}
        className="shrink-0 text-ink-dim hover:text-ink hover:underline"
      >
        Not now
      </button>
    </div>
  );
}
