import { useCallback, useEffect, useRef, useState } from "react";

/** A message the open conversation received, as a screen reader will hear it. */
export interface Heard {
  from: string;
  text: string;
  /** A reply in the open thread, rather than a message in the channel. */
  inThread: boolean;
}

/** Enough to know what a message is about; the rest is one keypress away. */
const LONGEST = 200;
/** Names read before the rest become a count. */
const NAMED = 3;

/** What is read for messages that arrived together. */
export function describeHeard(heard: Heard[]): string {
  if (heard.length === 1) {
    const { from, text, inThread } = heard[0]!;
    const said = text.length > LONGEST ? `${text.slice(0, LONGEST - 1)}…` : text;
    return `${from}${inThread ? " replied in the thread" : ""}: ${said}`;
  }
  const people = [...new Set(heard.map((h) => h.from))];
  const named =
    people.length > NAMED ? [...people.slice(0, NAMED), `${people.length - NAMED} others`] : people;
  const from = new Intl.ListFormat(undefined, { type: "conjunction" }).format(named);
  return `${heard.length} new messages, from ${from}`;
}

/**
 * Reads new messages in the open conversation to a screen reader, politely and
 * at most once every few seconds. The first is read as it arrives; any that
 * follow within the quiet time are read together when it ends, as a count and
 * who sent them, so a busy channel does not talk over everything else.
 */
export function useMessageAnnouncer(quietMs = 3000) {
  const [said, setSaid] = useState<{ id: number; text: string }[]>([]);
  const waiting = useRef<Heard[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quietUntil = useRef(0);
  const nextId = useRef(0);

  const stopTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stopTimer, []);

  const say = useCallback(() => {
    timer.current = null;
    const heard = waiting.current;
    waiting.current = [];
    if (heard.length === 0) return;
    quietUntil.current = Date.now() + quietMs;
    const text = describeHeard(heard);
    // A log reads what is added; the last few stay for anyone reading back.
    setSaid((prev) => [...prev.slice(-2), { id: nextId.current++, text }]);
  }, [quietMs]);

  const hear = useCallback(
    (heard: Heard) => {
      waiting.current.push(heard);
      if (timer.current) return;
      const wait = quietUntil.current - Date.now();
      if (wait <= 0) say();
      else timer.current = setTimeout(say, wait);
    },
    [say],
  );

  /** Somebody moved to another conversation: what the last one received is not news there. */
  const forget = useCallback(() => {
    stopTimer();
    waiting.current = [];
    setSaid([]);
  }, []);

  const region = (
    <div role="log" aria-label="New messages" className="sr-only">
      {said.map((s) => (
        <p key={s.id}>{s.text}</p>
      ))}
    </div>
  );

  return { hear, forget, region };
}
