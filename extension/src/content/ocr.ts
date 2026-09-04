import { createWorker } from "tesseract.js";

export interface OcrRegion {
  bbox: readonly [number, number, number, number];
}

export interface OcrResult {
  text: string;
  confidence: number;
}

export interface OcrWorker {
  recognize(image: HTMLCanvasElement): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<unknown>;
}

export interface OcrWorkerFactory {
  (): Promise<OcrWorker>;
}

export const createLocalOcrWorker: OcrWorkerFactory = async () => createWorker("eng");

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
    const cropped = cropImage(source, region);
    const result = await worker.recognize(cropped);
    return { text: result.data.text.trim(), confidence: result.data.confidence };
  } finally {
    await worker.terminate();
  }
}
