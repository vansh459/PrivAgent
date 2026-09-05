import { describe, expect, it } from "vitest";
import { DUPLICATE_IOU_THRESHOLD, fuseScreenElements, overlap } from "../src/content/fusion";
import type { ScreenStateElement } from "../src/schemas/screenState";

function dom(id: string, bbox: ScreenStateElement["bbox"]): ScreenStateElement {
  return { id, role: "button", text: "Save", bbox, source: "dom", sensitive: false };
}

function vision(id: string, bbox: ScreenStateElement["bbox"]): ScreenStateElement {
  return {
    id,
    role: "text",
    text: "Save",
    bbox,
    source: "vision_ocr",
    sensitive: false,
    confidence: 0.9,
  };
}

describe("fuseScreenElements", () => {
  it("keeps DOM semantics and removes overlapping vision duplicates", () => {
    const fused = fuseScreenElements(
      [dom("dom_1", [0, 0, 100, 30])],
      [vision("vision_1", [2, 1, 98, 29]), vision("vision_2", [200, 0, 100, 100])],
    );

    expect(fused.map(({ id }) => id)).toEqual(["dom_1", "vision_2"]);
  });

  it("keeps a vision region the DOM only partially covers", () => {
    const fused = fuseScreenElements(
      [dom("dom_1", [0, 0, 100, 30])],
      [vision("vision_1", [0, 0, 100, 90])],
    );

    expect(fused.map(({ id }) => id)).toEqual(["dom_1", "vision_1"]);
  });

  it("computes intersection over union", () => {
    expect(overlap([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(overlap([0, 0, 10, 10], [20, 20, 10, 10])).toBe(0);
    expect(overlap([0, 0, 10, 10], [0, 0, 5, 10])).toBeCloseTo(0.5);
  });

  it("treats the threshold as inclusive", () => {
    expect(DUPLICATE_IOU_THRESHOLD).toBe(0.7);
    expect(
      fuseScreenElements([dom("dom_1", [0, 0, 10, 10])], [vision("v", [0, 0, 10, 10])]),
    ).toEqual([dom("dom_1", [0, 0, 10, 10])]);
  });
});
