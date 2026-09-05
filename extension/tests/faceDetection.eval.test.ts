import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ort from "onnxruntime-web";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { detectFacesInImage, type FaceDetection } from "../src/content/faceDetection";
import { buildFaceScenes, type FaceScene } from "./helpers/faceScenes";
import { encodeRgbaPng } from "./helpers/png";

/**
 * Phase 2.3's stated criterion, measured: recall over a labelled 20-image set.
 *
 * A detection counts only if it overlaps a ground-truth face by IoU >= 0.5, the standard
 * bar - a box that merely touches a face would leave part of it unmasked, so a looser
 * threshold here would be scoring something other than what redaction needs.
 *
 * Precision is reported alongside because recall alone is trivially gamed: a detector
 * that returns the whole viewport scores 100% recall and protects nothing. It is not the
 * gate, though. Over-masking costs a grey rectangle; under-masking costs a face.
 */

const IOU_MATCH_THRESHOLD = 0.5;
const failureDir = resolve(import.meta.dirname, "..", "test-results", "face-eval");

let session: ort.InferenceSession;
let scenes: FaceScene[];

beforeAll(async () => {
  const model = new Uint8Array(
    readFileSync(
      resolve(import.meta.dirname, "..", "assets", "models", "face_detection_yunet_2023mar.onnx"),
    ),
  );
  session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
  scenes = buildFaceScenes();
}, 120_000);

function iou(a: readonly number[], b: readonly number[]): number {
  const left = Math.max(a[0]!, b[0]!);
  const top = Math.max(a[1]!, b[1]!);
  const right = Math.min(a[0]! + a[2]!, b[0]! + b[2]!);
  const bottom = Math.min(a[1]! + a[3]!, b[1]! + b[3]!);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a[2]! * a[3]! + b[2]! * b[3]! - intersection;
  return union <= 0 ? 0 : intersection / union;
}

interface SceneScore {
  id: string;
  expected: number;
  matched: number;
  detections: FaceDetection[];
  best: number[];
}

/** Greedy one-to-one matching of detections to labelled faces. */
function score(scene: FaceScene, detections: FaceDetection[]): SceneScore {
  const taken = new Set<number>();
  const best: number[] = [];
  let matched = 0;

  for (const face of scene.faces) {
    let bestIou = 0;
    let bestIndex = -1;
    detections.forEach((detection, index) => {
      if (taken.has(index)) return;
      const overlap = iou(face.bbox, detection.bbox);
      if (overlap > bestIou) {
        bestIou = overlap;
        bestIndex = index;
      }
    });
    best.push(Number(bestIou.toFixed(3)));
    if (bestIou >= IOU_MATCH_THRESHOLD && bestIndex >= 0) {
      taken.add(bestIndex);
      matched += 1;
    }
  }

  return { id: scene.id, expected: scene.faces.length, matched, detections, best };
}

/** Writes the scene with its boxes drawn, so a miss can be looked at rather than guessed at. */
function writeFailureImage(scene: FaceScene, detections: FaceDetection[]): string {
  mkdirSync(failureDir, { recursive: true });
  const copy = {
    width: scene.image.width,
    height: scene.image.height,
    data: new Uint8ClampedArray(scene.image.data),
  };
  const outline = (box: readonly number[], colour: [number, number, number]) => {
    for (let x = box[0]!; x < box[0]! + box[2]!; x += 1) {
      for (const y of [box[1]!, box[1]! + box[3]! - 1]) {
        const index = (Math.round(y) * copy.width + Math.round(x)) * 4;
        if (index >= 0 && index < copy.data.length) copy.data.set(colour, index);
      }
    }
    for (let y = box[1]!; y < box[1]! + box[3]!; y += 1) {
      for (const x of [box[0]!, box[0]! + box[2]! - 1]) {
        const index = (Math.round(y) * copy.width + Math.round(x)) * 4;
        if (index >= 0 && index < copy.data.length) copy.data.set(colour, index);
      }
    }
  };

  for (const face of scene.faces) outline(face.bbox, [0, 200, 0]);
  for (const detection of detections) outline(detection.bbox, [220, 0, 0]);

  const path = resolve(failureDir, `${scene.id}.png`);
  writeFileSync(path, encodeRgbaPng(copy));
  return path;
}

describe("YuNet face detection against the labelled 20-image set", () => {
  it("recalls at least 90% of labelled faces at IoU >= 0.5", async () => {
    const scored: SceneScore[] = [];
    for (const scene of scenes) {
      const detections = await detectFacesInImage(scene.image, { session });
      const result = score(scene, detections);
      scored.push(result);
      if (result.matched < result.expected) writeFailureImage(scene, detections);
    }

    const expected = scored.reduce((total, scene) => total + scene.expected, 0);
    const matched = scored.reduce((total, scene) => total + scene.matched, 0);
    const detected = scored.reduce((total, scene) => total + scene.detections.length, 0);
    const recall = matched / expected;
    const precision = detected === 0 ? 1 : matched / detected;

    console.log(
      `face detection: recall ${(recall * 100).toFixed(1)}% (${matched}/${expected}), ` +
        `precision ${(precision * 100).toFixed(1)}% (${matched}/${detected}), ` +
        `${scenes.length} scenes`,
    );
    for (const scene of scored) {
      console.log(
        `  ${scene.id}: ${scene.matched}/${scene.expected} matched, ` +
          `${scene.detections.length} detections, best IoU ${JSON.stringify(scene.best)}`,
      );
    }

    expect(scenes).toHaveLength(20);
    expect(expected).toBeGreaterThanOrEqual(20);
    expect(recall, "recall over the labelled set").toBeGreaterThanOrEqual(0.9);
    // Reported, and loosely gated: a detector that fires everywhere would still be
    // useless, but over-masking is the failure this project prefers to make.
    expect(precision, "precision over the labelled set").toBeGreaterThanOrEqual(0.6);
  }, 600_000);

  it("returns nothing on the face-free control scene", async () => {
    const control = scenes.find((scene) => scene.id === "no-faces")!;
    const detections = await detectFacesInImage(control.image, { session });

    expect(detections, JSON.stringify(detections)).toHaveLength(0);
  }, 120_000);

  it("scores a large, centred face far above the reporting threshold", async () => {
    const scene = scenes.find((item) => item.id === "large-portrait")!;
    const [detection] = await detectFacesInImage(scene.image, { session });

    expect(detection).toBeDefined();
    expect(detection!.confidence).toBeGreaterThan(0.9);
  }, 120_000);
});
