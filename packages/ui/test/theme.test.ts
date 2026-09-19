import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { avatarColor } from "../src/lib/format.js";

/** The colour tokens as theme.css declares them, by name without the prefix. */
function colourTokens(): Record<string, string> {
  const css = readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
  const tokens: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\b/gi))
    tokens[name!] = value!;
  return tokens;
}

/** WCAG 2 contrast ratio between two opaque sRGB colours, given as hex or as 0–1 channels. */
function contrast(a: string | number[], b: string | number[]): number {
  const channels = (colour: string | number[]) =>
    typeof colour === "string"
      ? [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16) / 255)
      : colour;
  const luminance = (colour: string | number[]) => {
    const [r, g, b] = channels(colour).map((c) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** `oklch(L C h)` to gamma-encoded sRGB channels, clipped to the gamut. */
function oklchToSrgb(css: string): number[] {
  const [L, C, h] = css.match(/[\d.]+/g)!.map(Number) as [number, number, number];
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((x) => {
    const c = Math.min(1, Math.max(0, x));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  });
}

/** Every pair below this ratio, written "text on surface", so a failure names the pair. */
function unreadable(pairs: [string, string][], minimum = 4.5): string[] {
  const tokens = colourTokens();
  return pairs
    .filter(([text, surface]) => contrast(tokens[text]!, tokens[surface]!) < minimum)
    .map(
      ([text, surface]) =>
        `${text} on ${surface}: ${contrast(tokens[text]!, tokens[surface]!).toFixed(2)}`,
    );
}

describe("the colour tokens", () => {
  it("are all declared", () => {
    expect(Object.keys(colourTokens())).toEqual(
      expect.arrayContaining([
        "deep",
        "ground",
        "raised",
        "lifted",
        "edge",
        "ink",
        "ink-dim",
        "ink-faint",
        "copper",
        "copper-deep",
        "online",
        "alert",
      ]),
    );
  });

  it("keep every ink readable on every surface", () => {
    const inks = ["ink", "ink-dim", "ink-faint", "copper", "online", "alert"];
    const surfaces = ["deep", "ground", "raised", "lifted"];
    expect(
      unreadable(inks.flatMap((ink) => surfaces.map((s): [string, string] => [ink, s]))),
    ).toEqual([]);
  });

  it("keep text written on the accent and alert fills readable", () => {
    // Buttons and badges on these fills write their text in the ground colour.
    expect(
      unreadable([
        ["ground", "copper"],
        ["ground", "copper-deep"],
        ["ground", "alert"],
      ]),
    ).toEqual([]);
  });
});

describe("colours written outside the stylesheet", () => {
  const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
  const hexes = (text: string) => [...text.matchAll(/#[0-9a-f]{6}\b/gi)].map(([hex]) => hex);

  it("match it, so no part of the app keeps the previous palette", () => {
    const tokens = colourTokens();
    // What the window and the browser show before the page paints, and the
    // title bar drawn over it.
    expect(hexes(read("apps/desktop/src/main/index.ts"))).toEqual([
      tokens.ground,
      tokens.ground,
      tokens["ink-dim"],
    ]);
    for (const page of ["apps/web/index.html", "apps/desktop/src/renderer/index.html"])
      expect(hexes(read(page)), page).toEqual([tokens.ground]);
    // The mark the favicon and the desktop icons are drawn from, as BrandMark draws it.
    for (const icon of [
      "apps/web/public/gatherline.svg",
      "apps/desktop/src/renderer/public/gatherline.svg",
    ])
      expect(hexes(read(icon)), icon).toEqual([tokens.copper, tokens.ground]);
  });
});

describe("avatar colours", () => {
  it("keep white initials readable on every one of them", () => {
    // The colour comes from a hash of the id, so enough ids reach every hue.
    const colours = new Set(Array.from({ length: 500 }, (_, i) => avatarColor(`U${i}`)));
    expect(colours.size).toBeGreaterThan(1);
    const white = [1, 1, 1];
    expect(
      [...colours]
        .map((css) => [css, contrast(white, oklchToSrgb(css))] as const)
        .filter(([, ratio]) => ratio < 4.5)
        .map(([css, ratio]) => `${css}: ${ratio.toFixed(2)}`),
    ).toEqual([]);
  });
});
