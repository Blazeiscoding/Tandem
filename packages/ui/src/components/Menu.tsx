import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Modal } from "./Modal.js";
import { Icon, type IconName } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";

export interface MenuItem {
  id: string;
  label: string;
  /** A small drawn icon before the label. */
  icon?: IconName;
  /**
   * Starts a group: a hairline above it, and its name when given. Items that
   * belong together read as one, so a long menu scans in sections.
   */
  section?: string | true;
  /** Danger-zone actions read red. */
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  /** Accessible name, e.g. "Actions for Sam Rivera". */
  label: string;
  items: MenuItem[];
  /** Small trigger for tight rows; default fits a full-width row. */
  triggerClassName?: string;
  triggerContent?: React.ReactNode;
  disabled?: boolean;
  /** A hint on the trigger, for one that shows only an icon. */
  tooltip?: string;
  /** Line the menu up with the trigger's start rather than its end. */
  align?: "start" | "end";
  /** Told when the menu opens and closes, for a trigger that hides on its own. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * One menu for every row of actions, so a person reads as a name rather than
 * five buttons. Built on the modal layer: Escape and a press outside close
 * only the menu, the page underneath stays inert, and focus returns to the
 * trigger. Arrow keys move, Enter chooses, Tab closes and returns focus.
 * Scrolling moves the menu with its trigger instead of dismissing it, so a
 * live timeline settling under an open menu does not take the menu with it.
 */
export function Menu({
  label,
  items,
  triggerClassName,
  triggerContent,
  disabled,
  tooltip,
  align = "end",
  onOpenChange,
}: MenuProps) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const trigger = useRef<HTMLButtonElement>(null);
  const button = (
    <button
      ref={trigger}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={typeof triggerContent === "undefined" ? label : undefined}
      disabled={disabled}
      onClick={() => setOpen(true)}
      className={
        triggerClassName ??
        "rounded-lg border border-edge px-2 py-1 text-[12px] text-ink-dim transition-colors hover:bg-ink/[0.05] hover:text-ink disabled:opacity-40"
      }
    >
      {triggerContent ?? <Icon name="dots" size={15} strokeWidth={2.6} />}
    </button>
  );

  return (
    <>
      {tooltip && !open ? <Tooltip label={tooltip}>{button}</Tooltip> : button}
      {open && (
        <MenuPanel
          label={label}
          items={items}
          align={align}
          anchor={() => trigger.current?.getBoundingClientRect() ?? null}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function MenuPanel({
  label,
  items,
  align,
  anchor,
  onClose,
}: {
  label: string;
  items: MenuItem[];
  align: "start" | "end";
  anchor: () => DOMRect | null;
  onClose: () => void;
}) {
  const [active, setActive] = useState(() => {
    const first = items.findIndex((item) => !item.disabled);
    return first === -1 ? 0 : first;
  });
  const list = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Sit under the trigger, aligned to its end; above it when the bottom
  // would run off the screen. Fixed, because the portal lives on the body.
  // Re-run on every scroll and resize so the menu follows its trigger;
  // only a trigger that is gone closes it.
  const place = useRef(() => {});
  place.current = () => {
    const box = anchor();
    const el = panel.current;
    if (!box || !el) {
      close.current();
      return;
    }
    const width = Math.max(200, Math.min(280, box.width));
    const height = Math.min(el.offsetHeight, window.innerHeight - 16);
    const roomBelow = window.innerHeight - box.bottom - 8;
    const top =
      roomBelow >= height || box.top < height
        ? Math.min(box.bottom + 4, window.innerHeight - height - 8)
        : Math.max(8, box.top - height - 4);
    el.style.width = `${width}px`;
    el.style.top = `${Math.max(8, top)}px`;
    // An aligned menu keeps the trigger's column; nudge back on screen.
    const left = align === "start" ? box.left : box.right - width;
    el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
  };
  useLayoutEffect(() => {
    place.current();
  }, [anchor, align]);
  useEffect(() => {
    const handler = () => place.current();
    document.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      document.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, []);

  // Focus the active item once the modal layer has registered, so its focus
  // recovery keeps it rather than pulling focus back to the panel.
  useLayoutEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-menu-index="${active}"]`)
      ?.focus({ preventScroll: true });
    // Only on mount; arrows move from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function move(next: number) {
    const enabled = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.disabled);
    if (enabled.length === 0) return;
    const at = enabled.findIndex(({ index }) => index === active);
    const pick = enabled[(at + next + enabled.length) % enabled.length]!.index;
    setActive(pick);
    list.current
      ?.querySelector<HTMLElement>(`[data-menu-index="${pick}"]`)
      ?.focus({ preventScroll: true });
  }

  function choose(index: number) {
    const item = items[index];
    if (!item || item.disabled) return;
    onClose();
    item.onSelect();
  }

  return (
    <Modal
      title={label}
      onClose={onClose}
      backdropClassName="bg-transparent"
      className="fixed outline-none"
    >
      <div
        ref={panel}
        role="menu"
        aria-label={label}
        className="surface-float fixed max-h-[60vh] animate-pop-in overflow-y-auto rounded-xl p-1 outline-none"
        onKeyDown={(event) => {
          // Tab leaves menus rather than cycling them; stop it reaching the
          // modal layer, which would trap it inside instead.
          if (event.key === "Tab") {
            event.stopPropagation();
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            move(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            move(-1);
          } else if (event.key === "Home") {
            event.preventDefault();
            const first = items.findIndex((item) => !item.disabled);
            if (first !== -1) {
              setActive(first);
              list.current
                ?.querySelector<HTMLElement>(`[data-menu-index="${first}"]`)
                ?.focus({ preventScroll: true });
            }
          } else if (event.key === "End") {
            event.preventDefault();
            for (let i = items.length - 1; i >= 0; i--) {
              if (!items[i]!.disabled) {
                setActive(i);
                list.current
                  ?.querySelector<HTMLElement>(`[data-menu-index="${i}"]`)
                  ?.focus({ preventScroll: true });
                break;
              }
            }
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            choose(active);
          }
        }}
      >
        <div ref={list} className="flex flex-col">
          {items.map((item, index) => (
            <div key={item.id} className="contents">
              {item.section && index > 0 && (
                <div role="separator" className="mx-1.5 my-1 h-px bg-edge" />
              )}
              {typeof item.section === "string" && (
                <div
                  aria-hidden="true"
                  className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-ink-faint"
                >
                  {item.section}
                </div>
              )}
              <button
                type="button"
                role="menuitem"
                data-menu-index={index}
                tabIndex={-1}
                disabled={item.disabled}
                aria-disabled={item.disabled || undefined}
                onClick={() => choose(index)}
                onMouseEnter={() => {
                  if (!item.disabled) setActive(index);
                }}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                  item.destructive
                    ? index === active && !item.disabled
                      ? "bg-alert/10 text-alert"
                      : "text-alert"
                    : index === active && !item.disabled
                      ? "bg-ink/[0.07] text-ink"
                      : "text-ink-dim"
                } disabled:opacity-40`}
              >
                {item.icon && (
                  <Icon
                    name={item.icon}
                    size={16}
                    className={item.destructive ? "" : "text-ink-faint"}
                  />
                )}
                {item.label}
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
