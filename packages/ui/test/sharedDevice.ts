import { applyOutboxChanges } from "@slackoss/client-core";
import type { Platform } from "../src/platform.js";

/**
 * One device's storage as the desktop app keeps it: every read, write and
 * outbox merge from every window takes its turn in one queue, and a merge is
 * a single turn (`applyOutboxChanges`, as `mergeOutboxSetting` runs it).
 * `pausedWindow` gives a window whose first read of `key` stops, once it has
 * its answer, until `resume` is called: the moment another window can act.
 */
export function sharedDevice(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  let queue: Promise<unknown> = Promise.resolve();
  const turn = <T>(op: () => T): Promise<T> => {
    const next = queue.then(op);
    queue = next.catch(() => {});
    return next;
  };
  const window = (hold?: { key: string; reached: () => void; until: Promise<void> }) => {
    let held = false;
    const platform: Platform = {
      kind: "desktop",
      notify: () => {},
      storage: {
        get: async <T>(name: string) => {
          const value = await turn(() => (values.get(name) ?? null) as T | null);
          if (hold && !held && name === hold.key) {
            held = true;
            hold.reached();
            await hold.until;
          }
          return value;
        },
        set: (name, value) =>
          turn(() => {
            if (value === null) values.delete(name);
            else values.set(name, value);
          }),
        mergeOutbox: (name, changes, enveloped) =>
          turn(() => {
            const { value, outbox } = applyOutboxChanges(
              values.get(name) ?? null,
              changes,
              enveloped,
            );
            values.set(name, value);
            return outbox;
          }),
      },
    };
    return platform;
  };
  const pausedWindow = (key: string) => {
    let resume = () => {};
    let reached = () => {};
    const paused = new Promise<void>((resolve) => (reached = resolve));
    const until = new Promise<void>((resolve) => (resume = resolve));
    return { platform: window({ key, reached, until }), paused, resume };
  };
  return { values, window, pausedWindow };
}
