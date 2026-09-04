import { beforeEach, describe, expect, it } from "vitest";
import { walkInteractiveDom } from "../src/content/domWalker";

const pages = [
  ["form", `<input placeholder="Email" /><input placeholder="Phone" /><button>Submit</button>`],
  [
    "dashboard",
    `<button>Refresh</button><a href="/reports">Reports</a><select><option>Monthly</option></select>`,
  ],
  [
    "portal",
    `<a href="/download">Download report</a><button>Open application</button><input placeholder="Search" />`,
  ],
  [
    "e-commerce",
    `<button>Add to cart</button><a href="/product">Product details</a><input placeholder="Coupon" />`,
  ],
  [
    "SPA",
    `<div role="menuitem" aria-label="Open navigation"></div><button>Save changes</button><textarea placeholder="Comment"></textarea>`,
  ],
] as const;

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

describe("DOM walker latency", () => {
  beforeEach(() => {
    const rectangle = {
      x: 0,
      y: 0,
      width: 120,
      height: 32,
      top: 0,
      right: 120,
      bottom: 32,
      left: 0,
      toJSON: () => ({}),
    };
    HTMLElement.prototype.getBoundingClientRect = () => rectangle;
  });

  it.each(pages)("has median extraction latency below 50ms for a %s fixture", (_siteType, html) => {
    document.body.innerHTML = html;
    const samples = Array.from({ length: 101 }, () => {
      const startedAt = performance.now();
      walkInteractiveDom();
      return performance.now() - startedAt;
    });

    expect(median(samples)).toBeLessThan(50);
  });
});
