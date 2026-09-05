import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SCORE_THRESHOLD,
  decodeStride,
  detectFacesInImage,
  letterboxTransform,
  suppressOverlaps,
  toModelInput,
  type RgbaSource,
} from "../src/content/faceDetection";

/**
 * Unit coverage for the detector's arithmetic. Accuracy is measured separately, against
 * the labelled set, in `faceDetection.eval.test.ts` - these are the pieces that would
 * silently produce plausible-looking boxes in the wrong place if they were wrong.
 */

function solid(width: number, height: number, rgb: [number, number, number]): RgbaSource {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = rgb[0];
    data[index * 4 + 1] = rgb[1];
    data[index * 4 + 2] = rgb[2];
    data[index * 4 + 3] = 255;
  }
  return { width, height, data };
}

describe("letterboxTransform", () => {
  it("centres a landscape image and pads top and bottom", () => {
    expect(letterboxTransform(1280, 800, 640)).toEqual({ scale: 0.5, offsetX: 0, offsetY: 120 });
  });

  it("centres a portrait image and pads left and right", () => {
    expect(letterboxTransform(400, 800, 640)).toEqual({ scale: 0.8, offsetX: 160, offsetY: 0 });
  });

  it("scales by the tighter axis, so nothing is cropped", () => {
    const { scale } = letterboxTransform(1920, 600, 640);
    expect(scale).toBeCloseTo(640 / 1920, 6);
    expect(600 * scale).toBeLessThanOrEqual(640);
  });
});

describe("toModelInput", () => {
  it("emits NCHW float32 at the model's fixed input size", () => {
    const tensor = toModelInput(solid(64, 32, [10, 20, 30]), 64);
    expect(tensor.dims).toEqual([1, 3, 64, 64]);
    expect(tensor.type).toBe("float32");
  });

  it("writes BGR, not RGB - the channel order the model was trained on", () => {
    const side = 64;
    const tensor = toModelInput(solid(64, 64, [10, 20, 30]), side);
    const data = tensor.data as Float32Array;
    const plane = side * side;
    expect(data[0]).toBe(30);
    expect(data[plane]).toBe(20);
    expect(data[2 * plane]).toBe(10);
  });

  it("leaves the padding black rather than smearing edge pixels into it", () => {
    const side = 64;
    // 64x32 letterboxes into the middle 32 rows; rows 0-15 and 48-63 are padding.
    const data = toModelInput(solid(64, 32, [255, 255, 255]), side).data as Float32Array;
    expect(data[0]).toBe(0);
    expect(data[side * 16]).toBe(255);
    expect(data[side * 63]).toBe(0);
  });

  it("keeps pixel values in 0-255 rather than normalizing them", () => {
    const data = toModelInput(solid(32, 32, [200, 100, 50]), 32).data as Float32Array;
    expect(Math.max(...data)).toBe(200);
  });
});

describe("decodeStride", () => {
  const side = 32;
  const stride = 8; // a 4x4 grid, 16 anchors

  function heads(scores: number[], boxes: number[][]) {
    return {
      cls: new Float32Array(scores),
      obj: new Float32Array(scores.map(() => 1)),
      box: new Float32Array(boxes.flat()),
    };
  }

  it("places an anchor's box at its own cell, scaled by the stride", () => {
    const scores = Array.from({ length: 16 }, (_, index) => (index === 5 ? 1 : 0));
    const boxes = Array.from({ length: 16 }, () => [0.5, 0.5, 0, 0]);
    const { cls, obj, box } = heads(scores, boxes);

    const [candidate] = decodeStride(cls, obj, box, stride, side, 0.5);

    // Anchor 5 is row 1, column 1: centre (1.5, 1.5) * 8 = (12, 12), size exp(0)*8 = 8.
    expect(candidate!.bbox).toEqual([8, 8, 8, 8]);
    expect(candidate!.score).toBe(1);
  });

  it("combines the two score heads geometrically", () => {
    const cls = new Float32Array(16).fill(0);
    const obj = new Float32Array(16).fill(0);
    cls[0] = 0.81;
    obj[0] = 0.49;
    const box = new Float32Array(64);

    const [candidate] = decodeStride(cls, obj, box, stride, side, 0.1);
    expect(candidate!.score).toBeCloseTo(Math.sqrt(0.81 * 0.49), 6);
  });

  it("drops everything below the score threshold", () => {
    const cls = new Float32Array(16).fill(0.3);
    const obj = new Float32Array(16).fill(0.3);
    expect(decodeStride(cls, obj, new Float32Array(64), stride, side, 0.4)).toEqual([]);
    expect(decodeStride(cls, obj, new Float32Array(64), stride, side, 0.2)).toHaveLength(16);
  });
});

describe("suppressOverlaps", () => {
  it("keeps the highest-scoring box of an overlapping cluster", () => {
    const kept = suppressOverlaps(
      [
        { bbox: [0, 0, 100, 100], score: 0.7 },
        { bbox: [5, 5, 100, 100], score: 0.9 },
        { bbox: [10, 10, 100, 100], score: 0.6 },
      ],
      0.3,
    );
    expect(kept).toEqual([{ bbox: [5, 5, 100, 100], score: 0.9 }]);
  });

  it("keeps boxes that describe genuinely separate faces", () => {
    const kept = suppressOverlaps(
      [
        { bbox: [0, 0, 50, 50], score: 0.9 },
        { bbox: [400, 0, 50, 50], score: 0.8 },
      ],
      0.3,
    );
    expect(kept).toHaveLength(2);
  });
});

describe("detectFacesInImage", () => {
  it("maps model-space boxes back into the image's own coordinates", async () => {
    // One anchor fires at the centre of the letterboxed 640x640 input; the image is
    // 1280x800, so scale 0.5 with 120px of vertical padding.
    const anchors = { 8: 6400, 16: 1600, 32: 400 } as const;
    const output: Record<string, { data: Float32Array }> = {};
    for (const [stride, count] of Object.entries(anchors)) {
      output[`cls_${stride}`] = { data: new Float32Array(count) };
      output[`obj_${stride}`] = { data: new Float32Array(count) };
      output[`bbox_${stride}`] = { data: new Float32Array(count * 4) };
    }
    // Stride 32, grid 20x20: anchor 210 is row 10, column 10 -> centre (10.5,10.5)*32.
    output["cls_32"]!.data[210] = 1;
    output["obj_32"]!.data[210] = 1;
    output["bbox_32"]!.data.set([0.5, 0.5, Math.log(2), Math.log(2)], 210 * 4);

    const session = { run: vi.fn(async () => output) };
    const found = await detectFacesInImage(solid(1280, 800, [0, 0, 0]), {
      session: session as never,
    });

    // Model space: centre (336,336), size 64 -> box [304,304,64,64].
    // Image space: /0.5 with the 120px pad removed -> [608,368,128,128].
    expect(found).toEqual([{ bbox: [608, 368, 128, 128], confidence: 1 }]);
  });

  it("clamps a box that runs past the edge of the image", async () => {
    const output: Record<string, { data: Float32Array }> = {};
    for (const [stride, count] of [
      [8, 6400],
      [16, 1600],
      [32, 400],
    ] as const) {
      output[`cls_${stride}`] = { data: new Float32Array(count) };
      output[`obj_${stride}`] = { data: new Float32Array(count) };
      output[`bbox_${stride}`] = { data: new Float32Array(count * 4) };
    }
    // Anchor 0 of stride 32, with a box far larger than its cell: runs off the top-left.
    output["cls_32"]!.data[0] = 1;
    output["obj_32"]!.data[0] = 1;
    output["bbox_32"]!.data.set([0, 0, Math.log(10), Math.log(10)], 0);

    const [found] = await detectFacesInImage(solid(640, 640, [0, 0, 0]), {
      session: { run: async () => output } as never,
    });

    expect(found!.bbox[0]).toBeGreaterThanOrEqual(0);
    expect(found!.bbox[1]).toBeGreaterThanOrEqual(0);
    expect(found!.bbox[0] + found!.bbox[2]).toBeLessThanOrEqual(640);
    expect(found!.bbox[1] + found!.bbox[3]).toBeLessThanOrEqual(640);
  });

  it("defaults to a recall-biased score threshold", () => {
    // Not a style preference: the whole redaction argument rests on this asymmetry.
    expect(DEFAULT_SCORE_THRESHOLD).toBeLessThan(0.9);
  });
});
