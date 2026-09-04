import { describe, expect, it, vi } from "vitest";
import { detectFaces } from "../src/content/faceDetection";

describe("detectFaces", () => {
  it("returns no detections when the local browser API is unavailable", async () => {
    expect(await detectFaces(document.createElement("canvas"))).toEqual([]);
  });

  it("normalizes local face bounding boxes", async () => {
    const detector = {
      detect: vi
        .fn()
        .mockResolvedValue([{ boundingBox: { x: 1.4, y: 2.6, width: 30.2, height: 40.8 } }]),
    };
    vi.stubGlobal(
      "FaceDetector",
      class {
        detect = detector.detect;
      },
    );
    await expect(detectFaces(document.createElement("canvas"))).resolves.toEqual([
      { bbox: [1, 3, 30, 41], confidence: 1 },
    ]);
    vi.unstubAllGlobals();
  });
});
