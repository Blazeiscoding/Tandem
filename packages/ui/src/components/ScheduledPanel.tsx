import { useCallback, useEffect, useState } from "react";
import type { ID, ScheduledMessage } from "@slackoss/protocol";
import { useClient, useWorkspace } from "../context.js";
import { channelTitle } from "../lib/format.js";
import { formatScheduleTime } from "../lib/schedule.js";
import { Mrkdwn } from "./Mrkdwn.js";

/** Messages queued to go out later, with the option to call them back. */
export function ScheduledPanel(props: { onClose: () => void; onJump: (channelId: ID) => void }) {
  const client = useClient();
  const users = useWorkspace((s) => s.users);
  const channels = useWorkspace((s) => s.channels);
  const selfId = useWorkspace((s) => s.self?.id);
  const [items, setItems] = useState<ScheduledMessage[] | null>(null);

  const load = useCallback(() => {
    client.api
      .listScheduled()
      .then((r) => setItems(r.scheduled))
      .catch(() => setItems([]));
  }, [client]);

  useEffect(() => {
    load();
    // Entries vanish as they send, so keep the list honest while it is open.
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  async function cancel(id: ID) {
    setItems((prev) => prev?.filter((s) => s.id !== id) ?? null);
    await client.api.cancelScheduled(id).catch(load);
  }

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-edge bg-ground">
      <header className="flex h-[53px] shrink-0 items-center justify-between border-b border-edge px-4">
        <h2 className="font-bold">Scheduled</h2>
        <button
          onClick={props.onClose}
          aria-label="Close scheduled messages"
          className="rounded-lg px-2 py-1 text-ink-dim transition-colors hover:bg-lifted hover:text-ink"
        >
          ✕
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-3">
        {items === null && (
          <p className="py-6 text-center font-mono text-xs text-ink-faint">loading…</p>
        )}
        {items?.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-ink-faint">
            Nothing queued. Write a message and pick 🕘 to send it later.
          </p>
        )}
        <ul className="space-y-2">
          {(items ?? []).map((s) => {
            const channel = channels[s.channelId];
            return (
              <li key={s.id} className="rounded-xl border border-edge bg-raised p-3">
                <div className="mb-1.5 flex items-center gap-2 text-[11px]">
                  <button
                    onClick={() => props.onJump(s.channelId)}
                    className="font-medium text-copper hover:underline"
                  >
                    {channel
                      ? channel.name
                        ? `#${channel.name}`
                        : channelTitle(channel, users, selfId)
                      : "unknown"}
                  </button>
                  <span className="ml-auto font-mono text-ink-faint">
                    {formatScheduleTime(s.sendAt)}
                  </span>
                </div>
                <div className="text-sm text-ink-dim">
                  {s.text ? (
                    <Mrkdwn text={s.text} users={users} channels={channels} selfId={selfId} />
                  ) : (
                    <span className="italic">
                      {s.fileIds.length} {s.fileIds.length === 1 ? "file" : "files"}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => void cancel(s.id)}
                  className="mt-2 rounded-lg border border-edge px-2.5 py-1 text-[12px] text-ink-faint transition-colors hover:border-alert hover:text-alert"
                >
                  Cancel
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
