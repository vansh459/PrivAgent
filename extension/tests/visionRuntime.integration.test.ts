import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ort from "onnxruntime-web";
import { describe, expect, it } from "vitest";
import { createVisionSession, FACE_MODEL_INPUT_SIZE } from "../src/content/visionRuntime";
import { IDENTITY_PROBE_MODEL } from "../src/models/identityProbeModel";

/**
 * Runs the real ONNX Runtime against the model the extension actually ships.
 *
 * The previous version of this test executed a 100-byte Identity graph, which proved only
 * that the runtime could load *something*. A detector with three output strides and 8400
 * anchors is a different claim: it exercises the operator set the perception pipeline
 * depends on, and it is the file in `extension/assets/` byte for byte.
 */

const faceModel = new Uint8Array(
  readFileSync(
    resolve(import.meta.dirname, "..", "assets", "models", "face_detection_yunet_2023mar.onnx"),
  ),
);

describe("local ONNX vision runtime", () => {
  it("executes the tiny capability probe through the WASM fallback", async () => {
    const { backend, session } = await createVisionSession(IDENTITY_PROBE_MODEL);
    const output = await session.run({ input: new ort.Tensor("float32", [42], [1]) });

    expect(backend).toBe("wasm");
    expect(output.output.data).toEqual(new Float32Array([42]));
  });

  it("executes the shipped face detector and returns every expected output head", async () => {
    const side = FACE_MODEL_INPUT_SIZE;
    const { backend, session } = await createVisionSession(faceModel);
    const output = await session.run({
      input: new ort.Tensor("float32", new Float32Array(3 * side * side).fill(128), [
        1,
        3,
        side,
        side,
      ]),
    });

    expect(backend).toBe("wasm");
    // Three strides x {classification, objectness, box, keypoints}, at 80/40/20 grid.
    for (const [name, anchors, width] of [
      ["cls_8", 6400, 1],
      ["cls_16", 1600, 1],
      ["cls_32", 400, 1],
      ["obj_8", 6400, 1],
      ["bbox_8", 6400, 4],
      ["bbox_32", 400, 4],
      ["kps_16", 1600, 10],
    ] as const) {
      expect(output[name].dims, `${name} shape`).toEqual([1, anchors, width]);
    }
    // Scores come out of the graph already sigmoid-activated; postprocessing relies on it.
    for (const score of output["cls_8"].data as Float32Array) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});
