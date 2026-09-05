import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ort from "onnxruntime-web";
import { beforeAll, describe, expect, it } from "vitest";
import { detectFacesInImage } from "../src/content/faceDetection";
import { MASK_COLOUR, isFullyMasked, maskRegions, paddedBox } from "../src/vision/redactPixels";
import { buildFaceScenes, type FaceScene } from "./helpers/faceScenes";
import { encodeRgbaPng } from "./helpers/png";

/**
 * Phase 3.3's criterion, measured: every face flagged by the Phase 2.3 detector, on the
 * same labelled 20-image set, is visibly masked afterwards.
 *
 * "Visibly masked" is checked two ways, because a masking function that ran is not the
 * same claim as a face that is gone. First, the centre of every labelled face carries the
 * mask colour. Second - the stronger check - the detector is run again over the masked
 * image and must find nothing: if a face is still recognisable to the model that found
 * it, it has not been redacted, whatever the pixels look like.
 *
 * Every masked scene is written to `test-results/redaction/` so the claim can also be
 * checked by looking at it, which is what "visibly" ultimately means.
 */

/** The central 60% of a box: eyes, nose and mouth, without the hair around them. */
function core([x, y, width, height]: readonly number[]): [number, number, number, number] {
  return [
    Math.round(x! + width! * 0.2),
    Math.round(y! + height! * 0.2),
    Math.round(width! * 0.6),
    Math.round(height! * 0.6),
  ];
}

let session: ort.InferenceSession;
let scenes: FaceScene[];
const artifactDir = resolve(import.meta.dirname, "..", "test-results", "redaction");

beforeAll(async () => {
  const model = new Uint8Array(
    readFileSync(
      resolve(import.meta.dirname, "..", "assets", "models", "face_detection_yunet_2023mar.onnx"),
    ),
  );
  session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
  scenes = buildFaceScenes();
}, 120_000);

describe("pixel redaction over the labelled face set", () => {
  it("masks every detected face, and the detector can no longer find one", async () => {
    let facesFound = 0;
    let facesRemaining = 0;
    let scenesWithFaces = 0;

    for (const scene of scenes) {
      const detections = await detectFacesInImage(scene.image, { session });
      if (detections.length === 0) continue;
      scenesWithFaces += 1;
      facesFound += detections.length;

      const painted = maskRegions(
        scene.image,
        detections.map((detection) => detection.bbox),
      );
      expect(painted, `${scene.id}: nothing was painted`).toBeGreaterThan(0);

      // The centre of every labelled face is covered, not merely the boxes the
      // detector chose to return. The whole labelled rectangle is deliberately not
      // required: the label is the rectangle a face crop was pasted into, which
      // includes hair and background, while a detector box stops at the eyebrows and
      // the chin. Painting out to the full label would mean masking a quarter of the
      // surrounding page on every avatar. The centre 60% is the face itself.
      for (const face of scene.faces) {
        expect(
          isFullyMasked(scene.image, core(face.bbox)),
          `${scene.id}: the centre of a labelled face survived masking`,
        ).toBe(true);
      }

      const afterwards = await detectFacesInImage(scene.image, { session });
      facesRemaining += afterwards.length;

      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(resolve(artifactDir, `${scene.id}.png`), encodeRgbaPng(scene.image));
    }

    console.log(
      `pixel redaction: ${facesFound} faces masked across ${scenesWithFaces} scenes; ` +
        `${facesRemaining} still detected afterwards`,
    );

    expect(scenesWithFaces).toBeGreaterThanOrEqual(19);
    expect(facesFound).toBeGreaterThanOrEqual(27);
    expect(facesRemaining, "a face survived redaction").toBe(0);
  }, 600_000);
});

describe("maskRegions", () => {
  function blank(width: number, height: number) {
    return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(200) };
  }

  it("pads the detector's box, which stops at the eyebrows and the chin", () => {
    expect(paddedBox([100, 100, 50, 80], 500, 500)).toEqual([95, 92, 60, 96]);
  });

  it("clamps padding at the edges instead of writing out of bounds", () => {
    const image = blank(40, 40);
    const painted = maskRegions(image, [[0, 0, 20, 20]]);

    expect(painted).toBeGreaterThan(0);
    expect(image.data).toHaveLength(40 * 40 * 4);
    expect(Array.from(image.data.slice(0, 3))).toEqual([...MASK_COLOUR]);
  });

  it("leaves everything outside the padded box untouched", () => {
    const image = blank(60, 60);
    maskRegions(image, [[10, 10, 10, 10]]);

    // The padded box is [9,9,12,12]; (30,30) is well outside it.
    const index = (30 * 60 + 30) * 4;
    expect(image.data[index]).toBe(200);
  });

  it("paints nothing when there is nothing to mask", () => {
    const image = blank(10, 10);
    expect(maskRegions(image, [])).toBe(0);
    expect(image.data[0]).toBe(200);
  });
});
