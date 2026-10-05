/**
 * Keyboard shortcuts as the person's own keyboard labels them: ⌘ on a Mac,
 * Ctrl everywhere else. A hint that names the wrong key teaches the wrong
 * habit, and on a touchscreen there is no keyboard to name at all.
 */
export function isApple(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The key held for shortcuts here: "⌘" or "Ctrl". */
export function modKey(): string {
  return isApple() ? "⌘" : "Ctrl";
}

/**
 * A shortcut written for people, from one written for code: "Mod+K" becomes
 * "⌘K" on a Mac and "Ctrl K" elsewhere; "Mod+Shift+U" becomes "⌘⇧U" or
 * "Ctrl Shift U".
 */
export function shortcutLabel(keys: string): string {
  const apple = isApple();
  const parts = keys.split("+").map((part) => {
    switch (part.toLowerCase()) {
      case "mod":
        return apple ? "⌘" : "Ctrl";
      case "shift":
        return apple ? "⇧" : "Shift";
      case "alt":
        return apple ? "⌥" : "Alt";
      case "enter":
        return apple ? "↩" : "Enter";
      default:
        return part;
    }
  });
  return apple ? parts.join("") : parts.join(" ");
}
