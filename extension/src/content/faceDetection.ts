import * as ort from "onnxruntime-web";
import { createVisionSession, FACE_MODEL_INPUT_SIZE, loadLocalModel } from "./visionRuntime";
import { LOCAL_ASSETS } from "../shared/assets";
import type { BoundingBox } from "../schemas/screenState";

/**
 * On-device face detection with the bundled YuNet model.
 *
 * This replaces a wrapper around the browser's Shape Detection API, which is absent from
 * Chrome desktop stable and from every Firefox - so the old implementation could never
 * succeed on a target browser, and the pipeline's only honest option was to throw. A
 * 232 KB ONNX model ships with the extension instead, and runs through the same local
 * runtime as everything else.
 *
 * Detection matters here because a face is PII no text detector can see: it is not a
 * string, it is pixels, arriving through <video>, <canvas> and cross-origin images that
 * the DOM walker can only describe as "an image". Phase 3.3 masks what this finds.
 */

export interface FaceDetection {
  bbox: BoundingBox;
  /** Geometric mean of the model's classification and objectness scores, 0-1. */
  confidence: number;
}

/** An `ImageData`-shaped input: row-major RGBA. Both the browser and Node produce this. */
export interface RgbaSource {
  readonly data: Uint8ClampedArray | Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface FaceDetectionOptions {
  /**
   * Minimum score to report.
   *
   * Deliberately far below OpenCV's 0.9 default, because the two errors are not
   * symmetric: a missed face is an unredacted face, while a false positive costs one
   * over-masked rectangle. Swept over the labelled set (see `faceDetection.eval.test.ts`)
   * at 0.15 / 0.25 / 0.35 / 0.5 / 0.6 - recall is 100% at and below 0.5 and drops to
   * 96.3% at 0.6, where a 47-pixel face is lost, while precision stays at 100% all the
   * way down to 0.15. Nothing on this set argues for a high threshold.
   */
  scoreThreshold?: number;
  /** Boxes overlapping a higher-scoring box by more than this are suppressed. */
  nmsThreshold?: number;
  session?: ort.InferenceSession;
}

export const DEFAULT_SCORE_THRESHOLD = 0.4;
export const DEFAULT_NMS_THRESHOLD = 0.3;

/** YuNet emits three feature-map strides; every anchor is one cell of one of them. */
const STRIDES = [8, 16, 32] as const;

let sessionPromise: Promise<ort.InferenceSession> | undefined;

/** Loads the detector once; sessions are expensive and the model never changes. */
export async function faceDetectionSession(): Promise<ort.InferenceSession> {
  sessionPromise ??= loadLocalModel(LOCAL_ASSETS.faceModel).then(
    async (model) => (await createVisionSession(model)).session,
  );
  return sessionPromise;
}

export function resetFaceDetectionForTesting(): void {
  sessionPromise = undefined;
}

export interface Letterbox {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Fits the image into the model's fixed 640x640 input without distorting it.
 *
 * The shipped graph has a fixed input size, so something has to give. Stretching a
 * 1280x800 viewport to a square would squeeze every face horizontally by 40%, which is
 * the deformation a face detector tolerates least; padding costs some resolution instead,
 * which it tolerates well.
 */
export function letterboxTransform(width: number, height: number, side: number): Letterbox {
  const scale = Math.min(side / width, side / height);
  return {
    scale,
    offsetX: Math.floor((side - width * scale) / 2),
    offsetY: Math.floor((side - height * scale) / 2),
  };
}

/** RGBA -> letterboxed BGR NCHW float32 in 0-255, which is what YuNet was trained on. */
export function toModelInput(source: RgbaSource, side = FACE_MODEL_INPUT_SIZE): ort.Tensor {
  const { scale, offsetX, offsetY } = letterboxTransform(source.width, source.height, side);
  const plane = side * side;
  const tensor = new Float32Array(3 * plane);

  const drawWidth = Math.round(source.width * scale);
  const drawHeight = Math.round(source.height * scale);

  for (let y = 0; y < drawHeight; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.floor(y / scale));
    for (let x = 0; x < drawWidth; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.floor(x / scale));
      const from = (sourceY * source.width + sourceX) * 4;
      const to = (y + offsetY) * side + (x + offsetX);
      // Channel order is BGR: the model was trained through OpenCV, which reads BGR.
      tensor[to] = source.data[from + 2]!;
      tensor[plane + to] = source.data[from + 1]!;
      tensor[2 * plane + to] = source.data[from]!;
    }
  }

  return new ort.Tensor("float32", tensor, [1, 3, side, side]);
}

interface Candidate {
  bbox: [number, number, number, number];
  score: number;
}

/**
 * Decodes one stride's anchors into scored boxes, in model-input coordinates.
 *
 * Anchors are laid out row-major over a (side/stride) grid and each box is regressed
 * relative to its own cell: centre as an offset within the cell, size as a log-scale
 * multiple of the stride. Both score heads leave the graph already sigmoid-activated, and
 * the two are combined geometrically - a box needs both "this is a face" and "something
 * is here", which is what stops textured background from scoring.
 */
export function decodeStride(
  cls: Float32Array,
  obj: Float32Array,
  box: Float32Array,
  stride: number,
  side: number,
  scoreThreshold: number,
): Candidate[] {
  const columns = Math.floor(side / stride);
  const found: Candidate[] = [];

  for (let index = 0; index < cls.length; index += 1) {
    const score = Math.sqrt(Math.max(0, cls[index]!) * Math.max(0, obj[index]!));
    if (score < scoreThreshold) continue;

    const column = index % columns;
    const row = Math.floor(index / columns);
    const centreX = (column + box[index * 4]!) * stride;
    const centreY = (row + box[index * 4 + 1]!) * stride;
    const width = Math.exp(box[index * 4 + 2]!) * stride;
    const height = Math.exp(box[index * 4 + 3]!) * stride;

    found.push({ bbox: [centreX - width / 2, centreY - height / 2, width, height], score });
  }

  return found;
}

function iou(a: readonly number[], b: readonly number[]): number {
  const left = Math.max(a[0]!, b[0]!);
  const top = Math.max(a[1]!, b[1]!);
  const right = Math.min(a[0]! + a[2]!, b[0]! + b[2]!);
  const bottom = Math.min(a[1]! + a[3]!, b[1]! + b[3]!);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a[2]! * a[3]! + b[2]! * b[3]! - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/** Greedy non-maximum suppression: keep the best box, drop what it overlaps. */
export function suppressOverlaps(candidates: Candidate[], threshold: number): Candidate[] {
  const kept: Candidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    if (kept.every((chosen) => iou(chosen.bbox, candidate.bbox) < threshold)) kept.push(candidate);
  }
  return kept;
}

/** Maps a box from letterboxed model space back into the image's own coordinates. */
function toImageBox(
  bbox: readonly [number, number, number, number],
  { scale, offsetX, offsetY }: Letterbox,
  source: RgbaSource,
): BoundingBox {
  const left = Math.max(0, Math.min(source.width, (bbox[0] - offsetX) / scale));
  const top = Math.max(0, Math.min(source.height, (bbox[1] - offsetY) / scale));
  const right = Math.max(0, Math.min(source.width, (bbox[0] + bbox[2] - offsetX) / scale));
  const bottom = Math.max(0, Math.min(source.height, (bbox[1] + bbox[3] - offsetY) / scale));
  return [
    Math.round(left),
    Math.round(top),
    Math.round(right - left),
    Math.round(bottom - top),
  ] as BoundingBox;
}

/**
 * Detects faces in decoded pixels, returning boxes in the image's own coordinates.
 *
 * Takes pixels rather than a `CanvasImageSource` so the same code path is measurable
 * under Node - the accuracy numbers in the build spec come out of a test run, not out of
 * a screenshot someone eyeballed.
 */
export async function detectFacesInImage(
  source: RgbaSource,
  options: FaceDetectionOptions = {},
): Promise<FaceDetection[]> {
  const side = FACE_MODEL_INPUT_SIZE;
  const scoreThreshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const session = options.session ?? (await faceDetectionSession());
  const output = await session.run({ input: toModelInput(source, side) });

  const candidates: Candidate[] = [];
  for (const stride of STRIDES) {
    candidates.push(
      ...decodeStride(
        output[`cls_${stride}`]!.data as Float32Array,
        output[`obj_${stride}`]!.data as Float32Array,
        output[`bbox_${stride}`]!.data as Float32Array,
        stride,
        side,
        scoreThreshold,
      ),
    );
  }

  const transform = letterboxTransform(source.width, source.height, side);
  return suppressOverlaps(candidates, options.nmsThreshold ?? DEFAULT_NMS_THRESHOLD).map(
    ({ bbox, score }) => ({
      bbox: toImageBox(bbox, transform, source),
      confidence: Number(score.toFixed(4)),
    }),
  );
}

/** Browser entry point: rasterizes any drawable source, then detects on its pixels. */
export async function detectFaces(
  source: CanvasImageSource,
  options: FaceDetectionOptions = {},
): Promise<FaceDetection[]> {
  const sized = source as { width?: number; height?: number };
  const width = Number(sized.width ?? 0);
  const height = Number(sized.height ?? 0);
  if (!width || !height) throw new Error("Face detection needs a source with a known size");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D context is unavailable for face detection");
  context.drawImage(source, 0, 0);

  return detectFacesInImage(context.getImageData(0, 0, width, height), options);
}
