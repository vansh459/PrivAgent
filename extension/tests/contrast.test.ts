import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG AA contrast, checked against the token file rather than against a screenshot.
 *
 * Colour decisions are the easiest kind to make by eye and the easiest to get wrong, and
 * translucent surfaces are the easiest of all: a card at 0.82 alpha looks fine over the
 * page it was designed against and fails over the next one. Since the tokens are data, the
 * ratios can simply be computed - so they are, in both colour schemes, including over the
 * two worst backdrops the in-page prompt can land on.
 *
 * A failure here is a design bug, not a test bug. The fix is the token, not the threshold.
 */

const tokensPath = resolve(import.meta.dirname, "..", "src", "ui", "tokens.css");

/** WCAG's minimum for body text. Everything asserted below is body text. */
const AA_TEXT = 4.5;

type Rgb = [number, number, number];

/** Comments would otherwise swallow the declaration that follows them. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseBlock(css: string, from: number): Record<string, string> {
  const open = css.indexOf("{", from);
  const close = css.indexOf("}", open);
  const declarations: Record<string, string> = {};
  for (const line of css.slice(open + 1, close).split(";")) {
    const [name, ...rest] = line.split(":");
    if (!name?.trim().startsWith("--")) continue;
    declarations[name.trim()] = rest.join(":").trim();
  }
  return declarations;
}

/**
 * The token values for one colour scheme.
 *
 * The dark theme redefines a subset, so it is layered over the light one - which is exactly
 * how the cascade applies it in a browser.
 */
function scheme(mode: "light" | "dark"): Record<string, string> {
  const css = stripComments(readFileSync(tokensPath, "utf8"));
  const light = parseBlock(css, css.indexOf(":root {"));
  if (mode === "light") return light;
  const darkAt = css.indexOf("@media (prefers-color-scheme: dark)");
  return { ...light, ...parseBlock(css, css.indexOf(":root {", darkAt)) };
}

/** Follows `var(--x)` indirection until a literal colour falls out. */
function resolve_(tokens: Record<string, string>, name: string): string {
  let value = tokens[name];
  for (let hops = 0; value?.startsWith("var(") && hops < 8; hops += 1) {
    value = tokens[value.slice(4, value.indexOf(")")).trim()];
  }
  if (!value) throw new Error(`token ${name} does not resolve to a value`);
  return value;
}

function toRgb(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (!rgba) throw new Error(`cannot parse colour ${value}`);
  const parts = rgba[1]!.split(",").map((part) => Number(part.trim()));
  return { rgb: [parts[0]!, parts[1]!, parts[2]!], alpha: parts[3] ?? 1 };
}

/** Flattens a translucent colour onto an opaque one, as a browser composites it. */
function over(top: { rgb: Rgb; alpha: number }, bottom: Rgb): Rgb {
  return top.rgb.map((channel, index) =>
    Math.round(channel * top.alpha + bottom[index]! * (1 - top.alpha)),
  ) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: Rgb, background: Rgb): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

describe.each(["light", "dark"] as const)("%s scheme meets WCAG AA", (mode) => {
  const tokens = scheme(mode);
  const colour = (name: string) => toRgb(resolve_(tokens, name));
  const solid = (name: string) => colour(name).rgb;

  /** Every pair below is real body text on a real surface somewhere in the product. */
  const pairs: Array<[string, Rgb, Rgb]> = [
    ["body text on a card", solid("--fg"), solid("--surface")],
    ["body text on the canvas", solid("--fg"), solid("--canvas")],
    ["muted text on a card", solid("--fg-muted"), solid("--surface")],
    ["muted text on the canvas", solid("--fg-muted"), solid("--canvas")],
    ["subtle text on a card", solid("--fg-subtle"), solid("--surface")],
    ["link text on a card", solid("--accent-500"), solid("--surface")],
    ["primary button label", solid("--accent-fg"), solid("--accent-500")],
    ["primary button label, pressed", solid("--accent-fg"), solid("--accent-600")],
    ["success text on a card", solid("--success"), solid("--surface")],
    ["warning text on a card", solid("--warning"), solid("--surface")],
    ["danger text on a card", solid("--danger"), solid("--surface")],
    ["muted text in a sunken field", solid("--fg-muted"), solid("--surface-sunken")],
  ];

  it.each(pairs)("%s", (_name, foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  /**
   * The confirmation prompt floats over a page nobody has seen. Black and white are the
   * extremes its glass fill can be composited onto, so both are checked: if the text clears
   * AA on each, it clears AA on everything between them.
   */
  describe.each([
    ["a white page", [255, 255, 255] as Rgb],
    ["a black page", [0, 0, 0] as Rgb],
  ])("glass over %s", (_backdrop, page) => {
    const glass = over(colour("--glass-bg"), page);

    it("body text", () => {
      expect(contrast(solid("--fg"), glass)).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it("muted text", () => {
      expect(contrast(solid("--fg-muted"), glass)).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it("the risk label", () => {
      expect(contrast(solid("--danger"), glass)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(solid("--warning"), glass)).toBeGreaterThanOrEqual(AA_TEXT);
    });
  });
});
