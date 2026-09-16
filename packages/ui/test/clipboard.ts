import { vi } from "vitest";

/**
 * A page the browser gives no Clipboard API, as it does any page served over
 * plain http from somewhere other than this computer. Call after
 * userEvent.setup(), which puts a stand-in clipboard in place. Returns the undo.
 */
export function withoutClipboardApi(): () => void {
  const previous = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
  Object.defineProperty(window.navigator, "clipboard", { value: undefined, configurable: true });
  return () => {
    if (previous) Object.defineProperty(window.navigator, "clipboard", previous);
    else Reflect.deleteProperty(window.navigator, "clipboard");
  };
}

/**
 * document.execCommand("copy"), which jsdom lacks, doing what a browser does:
 * copying the selection in the field that has focus, if there is one.
 */
export function copyBySelection(options: { result?: boolean } = {}) {
  const copied: string[] = [];
  const execCommand = vi.fn((command: string) => {
    const field = document.activeElement;
    if (command !== "copy" || !(field instanceof HTMLTextAreaElement)) return false;
    copied.push(field.value.slice(field.selectionStart, field.selectionEnd));
    return options.result ?? true;
  });
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
  return {
    copied,
    restore: () => Reflect.deleteProperty(document, "execCommand"),
  };
}
