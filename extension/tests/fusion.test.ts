import { describe, expect, it } from "vitest";
import { fuseScreenElements } from "../src/content/fusion";

describe("fuseScreenElements", () => {
  it("keeps DOM semantics and removes overlapping vision duplicates", () => {
    const dom = [
      {
        id: "dom_1",
        role: "button",
        text: "Save",
        bbox: [0, 0, 100, 30] as const,
        source: "dom" as const,
        sensitive: false as const,
      },
    ];
    const vision = [
      {
        id: "vision_1",
        role: "text",
        text: "Save",
        bbox: [2, 1, 98, 29] as const,
        source: "vision" as const,
        sensitive: false,
        confidence: 0.9,
      },
      {
        id: "vision_2",
        role: "text",
        text: "Chart",
        bbox: [200, 0, 100, 100] as const,
        source: "vision" as const,
        sensitive: false,
        confidence: 0.9,
      },
    ];
    expect(fuseScreenElements(dom, vision).map(({ id }) => id)).toEqual(["dom_1", "vision_2"]);
  });
});
