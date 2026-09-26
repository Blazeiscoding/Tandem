import { useCallback, useEffect, useRef } from "react";
import type React from "react";

const MESSAGE = '[role="article"]';
const CONTROL = "a[href], button, input, select, textarea, [tabindex]";
/** Marks a control this hook took out of the Tab order, so it can put it back. */
const TAKEN = "data-roving-out";

/**
 * Makes a list of messages one Tab stop. Only the current message, the
 * newest until somebody moves, is in the Tab order, with its own controls; the
 * others and theirs are left out, so Tab passes the list in a few presses
 * rather than hundreds. ArrowUp and ArrowDown move between messages, Home and
 * End go to the first and last, Enter goes into a message's actions, and Escape
 * comes back out to the message.
 *
 * Controls stay where they are for a pointer and a screen reader's reading
 * cursor; only sequential Tab order changes.
 */
export function useRovingMessages(list: React.RefObject<HTMLElement | null>) {
  const current = useRef<HTMLElement | null>(null);
  /** Until somebody has been in the list, its Tab stop follows the newest message. */
  const chosen = useRef(false);

  const apply = useCallback(() => {
    const root = list.current;
    if (!root) return;
    const messages = [...root.querySelectorAll<HTMLElement>(MESSAGE)];
    if (!chosen.current || !current.current || !root.contains(current.current))
      current.current = messages.at(-1) ?? null;
    for (const message of messages) {
      const isCurrent = message === current.current;
      message.tabIndex = isCurrent ? 0 : -1;
      for (const control of message.querySelectorAll<HTMLElement>(CONTROL)) {
        if (isCurrent) {
          if (control.hasAttribute(TAKEN)) {
            control.removeAttribute(TAKEN);
            control.removeAttribute("tabindex");
          }
        } else if (!control.hasAttribute("tabindex")) {
          // A control with its own tabindex manages itself.
          control.setAttribute(TAKEN, "");
          control.tabIndex = -1;
        }
      }
    }
  }, [list]);

  // Messages arrive, leave and change without this list rendering again.
  useEffect(() => {
    const root = list.current;
    if (!root) return;
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [list, apply]);

  const onFocus = useCallback(
    (event: React.FocusEvent) => {
      const message = (event.target as HTMLElement).closest<HTMLElement>(MESSAGE);
      if (!message) return;
      chosen.current = true;
      if (message === current.current) return;
      current.current = message;
      apply();
    },
    [apply],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement;
      const message = target.closest<HTMLElement>(MESSAGE);
      const root = list.current;
      if (!message || !root) return;
      if (target !== message) {
        // Out of a message's controls, back to the message.
        if (event.key === "Escape") {
          event.preventDefault();
          message.focus();
        }
        return;
      }
      const messages = [...root.querySelectorAll<HTMLElement>(MESSAGE)];
      const at = messages.indexOf(message);
      const next = {
        ArrowDown: messages[at + 1],
        ArrowUp: messages[at - 1],
        Home: messages[0],
        End: messages.at(-1),
      }[event.key];
      if (event.key === "Enter") {
        const action = message.querySelector<HTMLElement>(".message-toolbar button");
        if (!action) return;
        event.preventDefault();
        action.focus();
        return;
      }
      if (!(event.key in { ArrowDown: 1, ArrowUp: 1, Home: 1, End: 1 })) return;
      event.preventDefault();
      if (!next) return;
      next.focus();
      next.scrollIntoView?.({ block: "nearest" });
    },
    [list],
  );

  return { onFocus, onKeyDown };
}
