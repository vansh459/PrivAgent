import { beforeEach, describe, expect, it } from "vitest";
import { perceiveDom, walkInteractiveDom } from "../src/content/domWalker";
import { setBoundingBox } from "./helpers/layout";

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
        aria_label: "Account reference",
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
        aria_label: "Open secure actions",
        bbox: [8, 12, 150, 28],
        source: "dom",
        sensitive: false,
      },
    ]);
  });

  it("returns a live node for every reported element id", () => {
    const { elements, refs } = perceiveDom();

    expect(refs.size).toBe(elements.length);
    for (const element of elements) {
      expect(refs.get(element.id)?.isConnected).toBe(true);
    }
  });
});

describe("perceivability filtering", () => {
  it.each([
    ["a zero-sized element", `<button id="t">Ghost</button>`, 0, 0],
    ["an off-screen collapsed element", `<button id="t">Ghost</button>`, -10, 0],
  ])("skips %s", (_case, html, width, height) => {
    document.body.innerHTML = html;
    setBoundingBox(document.querySelector("#t")!, 0, 0, width, height);

    expect(walkInteractiveDom()).toEqual([]);
  });

  it.each([
    ["display:none", `<button id="t" style="display:none">Hidden</button>`],
    ["visibility:hidden", `<button id="t" style="visibility:hidden">Hidden</button>`],
    ["the hidden attribute", `<button id="t" hidden>Hidden</button>`],
    ["aria-hidden", `<button id="t" aria-hidden="true">Hidden</button>`],
  ])("skips an element hidden by %s", (_case, html) => {
    document.body.innerHTML = html;
    setBoundingBox(document.querySelector("#t")!, 0, 0, 100, 30);

    expect(walkInteractiveDom()).toEqual([]);
  });
});
