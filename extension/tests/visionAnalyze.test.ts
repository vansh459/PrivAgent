import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("webextension-polyfill", () => ({ default: { runtime: {} } }));

const faceSession = vi.fn(async () => ({ run: vi.fn() }));
vi.mock("../src/content/faceDetection", async () => {
  const actual = await vi.importActual<typeof import("../src/content/faceDetection")>(
    "../src/content/faceDetection",
  );
  return { ...actual, faceDetectionSession: faceSession };
});

const ocrWorker = vi.fn(async () => ({ recognize: vi.fn(), terminate: vi.fn() }));
vi.mock("../src/content/ocr", async () => {
  const actual = await vi.importActual<typeof import("../src/content/ocr")>("../src/content/ocr");
  return { ...actual, sharedOcrWorker: ocrWorker };
});

const { decodeCapture, warmUpVision } = await import("../src/vision/analyze");

/**
 * The two parts of the analysis that only exist because of the browser: turning a
 * screenshot into pixels, and loading the models before they are needed.
 */

const imageData = { width: 0, height: 0, data: new Uint8ClampedArray() };
const drawImage = vi.fn();
const getImageData = vi.fn(() => imageData);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Uint8Array([1]))),
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 2560, height: 1600, close: vi.fn() })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
    getImageData,
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("decodeCapture", () => {
  it("rescales a device-pixel screenshot into CSS pixels", async () => {
    // A 2x display: the screenshot is 2560x1600 for a 1280x800 viewport. Every DOM
    // rectangle it is fused with is in CSS pixels, so this is where the two are reconciled
    // - once, at the boundary, rather than in each detector.
    const screenshot = await decodeCapture("data:image/png;base64,x", {
      width: 1280,
      height: 800,
    });

    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1280, 800);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 1280, 800);
    expect(screenshot.pixels).toBe(imageData);
    expect((screenshot.source as HTMLCanvasElement).width).toBe(1280);
  });

  it("releases the decoded bitmap even though the canvas keeps a copy", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 100, height: 100, close })),
    );

    await decodeCapture("data:image/png;base64,x", { width: 100, height: 100 });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports a missing canvas context rather than returning empty pixels", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    await expect(
      decodeCapture("data:image/png;base64,x", { width: 10, height: 10 }),
    ).rejects.toMatchObject({ code: "capability_unavailable" });
  });
});

describe("warmUpVision", () => {
  it("loads the detector and starts the OCR worker together", async () => {
    await warmUpVision();

    expect(faceSession).toHaveBeenCalledTimes(1);
    expect(ocrWorker).toHaveBeenCalledTimes(1);
  });
});
