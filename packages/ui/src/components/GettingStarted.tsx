import { useEffect, useMemo, useState } from "react";
import { useClient, usePlatform, useWorkspace } from "../context.js";
import {
  readWorkspaceStorage,
  workspaceStorageKey,
  writeWorkspaceStorage,
} from "../lib/workspaceStorage.js";
import { Icon } from "./Icon.js";

interface Saved {
  dismissed?: boolean;
  /** A huddle leaves nothing behind to look at later, so taking part is noted. */
  huddleTried?: boolean;
}

/** What the browser allows, or whether the desktop app shows its own. */
function notificationsOn(kind: "web" | "desktop"): boolean {
  if (kind === "desktop") return true;
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

/**
 * A short list for whoever set the workspace up: make a channel, bring
 * someone in, turn notifications on, try a huddle. Each step ticks itself
 * off from what has actually happened, the list goes once all four have, and
 * it can be put away sooner. Kept per workspace and account on this device.
 */
export function GettingStarted(props: {
  onNewChannel: () => void;
  onInvite: () => void;
  onNotifications: () => void;
  activeChannelName: string | null;
  onTryHuddle: () => void;
}) {
  const platform = usePlatform();
  const client = useClient();
  const self = useWorkspace((s) => s.self);
  const workspaceId = useWorkspace((s) => s.workspaceId);
  const channels = useWorkspace((s) => s.channels);
  const users = useWorkspace((s) => s.users);
  const inHuddle = useWorkspace((s) => s.huddle !== null);
  const key = useMemo(() => {
    const scoped = workspaceStorageKey(client.baseUrl, workspaceId, self?.id, "getting-started");
    return scoped && { key: scoped.key };
  }, [client.baseUrl, workspaceId, self?.id]);
  const [saved, setSaved] = useState<Saved | null>(null);
  // Notification permission changes outside the app, so look again on return.
  const [, recheck] = useState(0);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    readWorkspaceStorage<Saved>(platform, key)
      .catch(() => null)
      .then((value) => {
        if (alive) setSaved(value && typeof value === "object" ? value : {});
      });
    return () => {
      alive = false;
    };
  }, [platform, key]);

  const save = (next: Saved) => {
    setSaved(next);
    // Losing this only shows the list again; nothing to report.
    if (key) writeWorkspaceStorage(platform, key, next).catch(() => {});
  };

  useEffect(() => {
    if (inHuddle && saved && !saved.huddleTried) save({ ...saved, huddleTried: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inHuddle, saved]);

  useEffect(() => {
    const again = () => recheck((n) => n + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, []);

  if (self?.role !== "owner" || !saved || saved.dismissed) return null;
  const rooms = Object.values(channels).filter(
    (c) => (c.type === "public" || c.type === "private") && !c.archived,
  );
  const others = Object.values(users).filter((u) => u.id !== self.id && !u.isBot && !u.deactivated);
  const steps = [
    {
      label: "Create a channel",
      done: rooms.some((c) => c.name !== "general"),
      action: "New channel",
      onClick: props.onNewChannel,
    },
    {
      label: "Invite someone",
      done: others.length > 0,
      action: "Invite",
      onClick: props.onInvite,
    },
    {
      label: "Turn on notifications",
      done: notificationsOn(platform.kind),
      action: "Settings",
      onClick: props.onNotifications,
    },
    {
      label: props.activeChannelName
        ? `Try a huddle in ${props.activeChannelName}`
        : "Try a huddle",
      done: saved.huddleTried === true || inHuddle,
      action: "Start",
      onClick: props.onTryHuddle,
    },
  ];
  const left = steps.filter((step) => !step.done).length;
  if (left === 0) return null;

  return (
    <section
      aria-labelledby="getting-started-title"
      className="mb-3 rounded-xl border border-edge bg-ground/50 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="getting-started-title" className="text-[13px] font-semibold">
          Getting started
        </h2>
        <button
          onClick={() => save({ ...saved, dismissed: true })}
          className="rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:bg-lifted hover:text-ink"
        >
          Hide
        </button>
      </div>
      <p className="mt-0.5 text-[11px] text-ink-faint">
        {left} of {steps.length} left
      </p>
      <ul className="mt-2 space-y-1">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-2 text-[12px]">
            <span
              aria-hidden="true"
              className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${
                step.done ? "border-online bg-online/20 text-online" : "border-edge"
              }`}
            >
              {step.done && <Icon name="check" size={10} />}
            </span>
            <span
              className={`min-w-0 flex-1 truncate ${step.done ? "text-ink-faint line-through" : ""}`}
            >
              {step.label}
              <span className="sr-only">{step.done ? ", done" : ""}</span>
            </span>
            {!step.done && (
              <button
                onClick={step.onClick}
                aria-label={`${step.action}: ${step.label}`}
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-copper hover:bg-lifted"
              >
                {step.action}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
