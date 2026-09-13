import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library unmounts after each test by itself only when vitest's globals
// are on, and they are not.
afterEach(() => cleanup());

// jsdom does no layout, so every element reports no boxes, and code that skips
// what is not rendered (focus traps, for one) would skip everything. Stand in
// with the part of the answer that does not need layout: an element is rendered
// unless it, or something around it, is hidden or not displayed. That is
// narrower than a browser's answer, and a test that depends on real geometry
// belongs in the browser suite.
Element.prototype.getClientRects = function (this: Element) {
  for (let node: Element | null = this; node; node = node.parentElement) {
    if (
      !node.isConnected ||
      node.hasAttribute("hidden") ||
      getComputedStyle(node).display === "none"
    ) {
      return [] as unknown as DOMRectList;
    }
  }
  return [new DOMRect(0, 0, 1, 1)] as unknown as DOMRectList;
};
