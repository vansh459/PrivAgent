import { vi } from "vitest";

/**
 * jsdom has no layout engine, so every element reports a zero-sized rect. The walker
 * treats zero-sized elements as not perceivable, so tests must supply geometry.
 */
export function setBoundingBox(
  element: HTMLElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({}),
  } as DOMRect);
}

/** Gives every element a default non-zero rect, for tests that do not care about geometry. */
export function stubLayout(width = 120, height = 32): void {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    return {
      x: 0,
      y: 0,
      width,
      height,
      top: 0,
      right: width,
      bottom: height,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

/**
 * Gives named elements their own rectangles.
 *
 * Vision fusion is entirely about geometry - which observer saw which region - so those
 * tests need real per-element boxes rather than one shared default.
 */
export function layoutById(boxes: Record<string, [number, number, number, number]>): void {
  for (const [id, [x, y, width, height]] of Object.entries(boxes)) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`layoutById: no element with id "${id}"`);
    setBoundingBox(element, x, y, width, height);
  }
}
