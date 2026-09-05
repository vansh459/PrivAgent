import { createWorker, OEM } from "tesseract.js";
import { assetUrl, LOCAL_ASSETS } from "../shared/assets";
import type { BoundingBox } from "../schemas/screenState";

export interface OcrRegion {
  bbox: BoundingBox;
}

export interface OcrResult {
  text: string;
  /** Tesseract's mean per-character confidence, 0-100. */
  confidence: number;
}

export interface OcrWorker {
  recognize(image: HTMLCanvasElement): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
}

export interface OcrWorkerFactory {
  (): Promise<OcrWorker>;
}

/**
 * A Tesseract worker that reads its script, its WASM core and its language data from the
 * extension itself.
 *
 * All four defaults in `tesseract.js` point at `cdn.jsdelivr.net`: the worker script, the
 * core, the `eng.traineddata` and the blob-URL shim. Left alone, the first OCR pass would
 * make three requests to a CDN at the moment the user asked the agent to read their
 * screen - which is precisely the correlation this project exists to avoid. Every path
 * below is an extension-origin URL produced by `scripts/vendor-assets.mjs`.
 *
 * `workerBlobURL: false` matters twice over: it stops the worker script being fetched and
 * re-wrapped as a blob, and it keeps the worker on the extension's origin, where our own
 * CSP applies rather than the visited page's `worker-src`.
 *
 * LSTM_ONLY matches the vendored `tessdata_fast` data, which carries no legacy engine.
 */
export const createLocalOcrWorker: OcrWorkerFactory = async () =>
  (await createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: assetUrl(LOCAL_ASSETS.tesseractWorker),
    corePath: assetUrl(LOCAL_ASSETS.tesseractCoreDir),
    langPath: assetUrl(LOCAL_ASSETS.tessdataDir),
    workerBlobURL: false,
    gzip: true,
    // The language data is already local; caching it again in IndexedDB would only add a
    // second copy of a file we ship, and a second place to have to reason about.
    cacheMethod: "none",
  })) as unknown as OcrWorker;

function cropImage(source: CanvasImageSource, region: OcrRegion): HTMLCanvasElement {
  const [x, y, width, height] = region.bbox;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable for OCR cropping");
  context.drawImage(source, x, y, width, height, 0, 0, width, height);
  return canvas;
}

/** Reads a visible canvas/image region locally; callers own worker lifecycle. */
export async function recognizeRegion(
  source: CanvasImageSource,
  region: OcrRegion,
  workerFactory: OcrWorkerFactory = createLocalOcrWorker,
): Promise<OcrResult> {
  const worker = await workerFactory();
  try {
    return await readWith(worker, source, region);
  } finally {
    await worker.terminate();
  }
}

/**
 * Reads several regions with one worker, then disposes of it.
 *
 * Worker startup dominates: it instantiates a 2.8 MB WASM core and parses 2 MB of
 * language data, which is tens of times the cost of recognizing one small region. A page
 * with a canvas chart, a logo and an embedded image is three regions, and paying that
 * startup three times would put OCR outside the latency budget on its own.
 *
 * Callers that run repeatedly should hold a worker via `sharedOcrWorker()` instead, and
 * use `readRegions`; this one exists for single-shot use, where leaving a 3 MB WASM
 * instance alive afterwards would be the greater cost.
 */
export async function recognizeRegions(
  source: CanvasImageSource,
  regions: readonly OcrRegion[],
  workerFactory: OcrWorkerFactory = createLocalOcrWorker,
): Promise<OcrResult[]> {
  if (regions.length === 0) return [];
  const worker = await workerFactory();
  try {
    return await readRegions(worker, source, regions);
  } finally {
    await worker.terminate();
  }
}

/** Reads regions with a worker the caller owns and keeps. */
export async function readRegions(
  worker: OcrWorker,
  source: CanvasImageSource,
  regions: readonly OcrRegion[],
): Promise<OcrResult[]> {
  const results: OcrResult[] = [];
  for (const region of regions) results.push(await readWith(worker, source, region));
  return results;
}

let shared: Promise<OcrWorker> | undefined;

/**
 * A worker kept alive across passes.
 *
 * The alternative is paying ~2 seconds of WASM instantiation and language-data parsing on
 * every task, which is most of the end-to-end latency budget spent before a single
 * character is read. The cost of keeping it is memory in an offscreen document that
 * exists for no other purpose.
 */
export function sharedOcrWorker(
  factory: OcrWorkerFactory = createLocalOcrWorker,
): Promise<OcrWorker> {
  shared ??= factory().catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}

/** Releases the shared worker, if one was ever started. */
export async function releaseSharedOcrWorker(): Promise<void> {
  const worker = shared;
  shared = undefined;
  if (worker) await (await worker).terminate();
}

async function readWith(
  worker: OcrWorker,
  source: CanvasImageSource,
  region: OcrRegion,
): Promise<OcrResult> {
  const result = await worker.recognize(cropImage(source, region));
  return { text: result.data.text.trim(), confidence: result.data.confidence };
}
