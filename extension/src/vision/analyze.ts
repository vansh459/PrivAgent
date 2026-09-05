import {
  detectFacesInImage,
  faceDetectionSession,
  type FaceDetection,
  type RgbaSource,
} from "../content/faceDetection";
import { readRegions, sharedOcrWorker, type OcrRegion, type OcrResult } from "../content/ocr";
import { applyMaskToCanvas, maskRegions } from "./redactPixels";
import type { BoundingBox, ScreenStateElement } from "../schemas/screenState";
import { PrivAgentError } from "../shared/errors";

/**
 * The local vision analysis: everything the DOM cannot tell us about the screen.
 *
 * The DOM describes structure and the text it owns. It cannot say what is drawn inside a
 * <canvas>, what a chart's axis labels read, or that an <img> contains a person's face -
 * and those are exactly the places sensitive content hides from a text-only privacy
 * filter.
 *
 * This module runs in an *extension-origin* document, never in the visited page. That is
 * not a preference: a content script cannot construct a Worker from a `chrome-extension:`
 * URL - the script has to be same-origin with the document, and a content script's
 * document belongs to the site. Tesseract's only other option there is a blob-URL worker
 * running on the page's own origin under the page's CSP, which is both fragile and the
 * wrong place to be decoding a screenshot of the user's screen.
 */

/** A visual region to read, described in CSS pixels relative to the viewport. */
export interface VisualRegion extends OcrRegion {
  id: string;
  role: string;
  /** Text the DOM already knows for this element - `alt`, `aria-label`, `title`. */
  describedText: string;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface VisionAnalysis {
  elements: ScreenStateElement[];
  faces: number;
  /** Pixels painted over detected faces before anything else read the screenshot. */
  pixelsRedacted: number;
  regionsRead: number;
  millis: number;
  /** Per-stage wall clock, so a slow pass can be attributed rather than guessed at. */
  timings: VisionTimings;
}

export interface VisionTimings {
  /** Screenshot fetch, decode and rescale to CSS pixels. */
  decodeMs: number;
  /** One 640x640 detector pass over the whole screenshot. */
  detectMs: number;
  /** OCR across every unread region, worker startup excluded when one is already warm. */
  ocrMs: number;
}

/**
 * A decoded screenshot, in both forms the two detectors need.
 *
 * Face detection works on raw pixels, so the same code path can be scored under Node
 * against the labelled set; OCR crops with `drawImage`, which needs a drawable. Carrying
 * both avoids a copy per region.
 */
export interface Screenshot {
  pixels: RgbaSource;
  source: CanvasImageSource;
}

/** Tesseract reports 0-100; anything under this is noise being read out of gradients. */
export const MIN_OCR_CONFIDENCE = 50;

/**
 * Loads the detector and starts the OCR worker before anything needs them.
 *
 * Between them they are a 232 KB model, a 27 MB WASM runtime, a 3.9 MB OCR core and 2 MB
 * of language data. Loading all of that inside the first task means the first thing the
 * user asks for is also the slowest thing the agent ever does - tens of seconds, measured.
 * The popup calls this when it opens, so the cost is paid while the user is still typing.
 */
export interface WarmUpReport {
  /** Milliseconds to create the ONNX session for the face detector. */
  detectorMs: number;
  /** Milliseconds to start the OCR worker: WASM core plus language data. */
  ocrMs: number;
  totalMs: number;
}

export async function warmUpVision(): Promise<WarmUpReport> {
  const started = performance.now();
  const detector = faceDetectionSession().then(() => Math.round(performance.now() - started));
  const ocr = sharedOcrWorker().then(() => Math.round(performance.now() - started));
  const [detectorMs, ocrMs] = await Promise.all([detector, ocr]);
  return { detectorMs, ocrMs, totalMs: Math.round(performance.now() - started) };
}

/**
 * Decodes the screenshot into CSS-pixel space.
 *
 * `captureVisibleTab` returns device pixels, so on a 2x display every coordinate is
 * doubled relative to the DOM rectangles it has to be fused with. Rescaling here - once,
 * at the boundary - means nothing downstream has to know the display's pixel ratio, and a
 * fusion bug caused by mismatched coordinate spaces cannot happen.
 */
export async function decodeCapture(dataUrl: string, viewport: Viewport): Promise<Screenshot> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new PrivAgentError("capability_unavailable", "No 2D canvas context");
    context.drawImage(bitmap, 0, 0, viewport.width, viewport.height);
    return {
      pixels: context.getImageData(0, 0, viewport.width, viewport.height),
      source: canvas,
    };
  } finally {
    bitmap.close?.();
  }
}

export interface AnalyzeOptions {
  decode?: (dataUrl: string, viewport: Viewport) => Promise<Screenshot>;
  detect?: (source: RgbaSource) => Promise<FaceDetection[]>;
  read?: (source: CanvasImageSource, regions: readonly OcrRegion[]) => Promise<OcrResult[]>;
  /** Below this OCR confidence a read is discarded rather than reported as screen text. */
  minOcrConfidence?: number;
}

/**
 * Detects faces across the whole screenshot and reads the regions the DOM left blank.
 *
 * OCR skips any region whose element already carries an `alt` or `aria-label`: that text
 * is in the Screen State already, via the DOM walker, and reading the pixels again would
 * produce a second element for the same rectangle - the exact duplicate the fusion engine
 * then has to remove. Cheaper not to create it.
 *
 * Faces are detected over the entire screenshot rather than inside the listed regions,
 * because a face can be painted anywhere - a video call tile, a CSS background, a canvas
 * composited from several images - and a region list is a list of places we thought to
 * look.
 */
export async function analyzeScreenshot(
  dataUrl: string,
  regions: readonly VisualRegion[],
  viewport: Viewport,
  options: AnalyzeOptions = {},
): Promise<VisionAnalysis> {
  const started = performance.now();
  const decode = options.decode ?? decodeCapture;
  const detect = options.detect ?? ((source: RgbaSource) => detectFacesInImage(source));
  const read =
    options.read ??
    (async (source: CanvasImageSource, toRead: readonly OcrRegion[]) =>
      toRead.length === 0 ? [] : readRegions(await sharedOcrWorker(), source, toRead));

  const decodeStarted = performance.now();
  const screenshot = await decode(dataUrl, viewport);
  const detectStarted = performance.now();
  const faces = await detect(screenshot.pixels);
  // Destroy the faces before anything else reads the screenshot. OCR runs next, on the
  // same pixels, and the crops it sends to its worker come from this buffer - so masking
  // here is what guarantees no face reaches the worker, or any later consumer of the
  // capture. It happens whether or not OCR runs.
  const pixelsRedacted = maskRegions(
    screenshot.pixels,
    faces.map((face) => face.bbox),
  );
  if (pixelsRedacted > 0) applyMaskToCanvas(screenshot.source, screenshot.pixels);

  const ocrStarted = performance.now();
  const unread = regions.filter((region) => region.describedText.length === 0);
  const texts = await read(screenshot.source, unread);
  const finished = performance.now();

  const elements: ScreenStateElement[] = faces.map((face, index) => ({
    id: `face_${index + 1}`,
    role: "face",
    text: "",
    bbox: face.bbox,
    source: "vision_face",
    // A face is PII in pixels. Marking it sensitive is what makes the context builder
    // withhold it, so a detected face is never described to the server at all.
    sensitive: true,
    confidence: face.confidence,
  }));

  texts.forEach((result, index) => {
    const region = unread[index];
    if (!region || result.text.length === 0) return;
    if (result.confidence < (options.minOcrConfidence ?? MIN_OCR_CONFIDENCE)) return;
    elements.push({
      id: region.id,
      role: region.role,
      text: result.text,
      bbox: region.bbox as BoundingBox,
      source: "vision_ocr",
      sensitive: false,
      confidence: Number((result.confidence / 100).toFixed(4)),
    });
  });

  return {
    elements,
    faces: faces.length,
    pixelsRedacted,
    regionsRead: unread.length,
    millis: Math.round(finished - started),
    timings: {
      decodeMs: Math.round(detectStarted - decodeStarted),
      detectMs: Math.round(ocrStarted - detectStarted),
      ocrMs: Math.round(finished - ocrStarted),
    },
  };
}
