import { beforeEach, describe, expect, it, vi } from "vitest";
import { walkInteractiveDom } from "../src/content/domWalker";

function setBoundingBox(
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
  });
}

describe("walkInteractiveDom", () => {
  beforeEach(() => {
    document.body.innerHTML = `<form><input id="email" name="email" placeholder="Email address" /><input id="secret" aria-label="Account reference" /><button id="submit">Send report</button></form>`;
    setBoundingBox(document.querySelector("#email")!, 20, 30, 240, 32);
    setBoundingBox(document.querySelector("#secret")!, 20, 78, 240, 32);
    setBoundingBox(document.querySelector("#submit")!, 20, 126, 120, 40);
  });

  it("returns every form input and button with expected role, text, and bounding box", () => {
    expect(walkInteractiveDom()).toEqual([
      {
        id: "dom_1",
        role: "text_field",
        text: "Email address",
        bbox: [20, 30, 240, 32],
        source: "dom",
        sensitive: false,
      },
      {
        id: "dom_2",
        role: "text_field",
        text: "Account reference",
        ariaLabel: "Account reference",
        bbox: [20, 78, 240, 32],
        source: "dom",
        sensitive: false,
      },
      {
        id: "dom_3",
        role: "button",
        text: "Send report",
        bbox: [20, 126, 120, 40],
        source: "dom",
        sensitive: false,
      },
    ]);
  });

  it("captures explicit ARIA roles and labels when no visible text exists", () => {
    document.body.innerHTML = `<div id="menu" role="menuitem" aria-label="Open secure actions"></div>`;
    setBoundingBox(document.querySelector("#menu")!, 8, 12, 150, 28);

    expect(walkInteractiveDom()).toEqual([
      {
        id: "dom_1",
        role: "menuitem",
        text: "Open secure actions",
        ariaLabel: "Open secure actions",
        bbox: [8, 12, 150, 28],
        source: "dom",
        sensitive: false,
      },
    ]);
  });
});
