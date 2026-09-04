import { afterEach, describe, expect, it, vi } from "vitest";
import { recognizeRegion, type OcrWorkerFactory } from "../src/content/ocr";

function fixtureWorker(
  text: string,
  confidence = 95,
): {
  factory: OcrWorkerFactory;
  recognize: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
} {
  const recognize = vi.fn().mockResolvedValue({ data: { text, confidence } });
  const terminate = vi.fn().mockResolvedValue(undefined);
  return {
    factory: vi.fn().mockResolvedValue({ recognize, terminate }),
    recognize,
    terminate,
  } as unknown as {
    factory: OcrWorkerFactory;
    recognize: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  };
}

describe("recognizeRegion", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    "Download Report",
    "Invoice 2026",
    "Account Summary",
    "Search",
    "Settings",
    "Project Dashboard",
    "Order Details",
    "Application Status",
    "Save Changes",
    "Help Center",
  ])("returns trimmed local OCR text for fixture %s", async (expectedText) => {
    const canvas = document.createElement("canvas");
    const drawImage = vi.fn();
    vi.spyOn(canvas, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(document, "createElement").mockReturnValue(canvas);
    const { factory, recognize, terminate } = fixtureWorker(` ${expectedText} `);

    await expect(recognizeRegion(canvas, { bbox: [10, 20, 160, 32] }, factory)).resolves.toEqual({
      text: expectedText,
      confidence: 95,
    });
    expect(drawImage).toHaveBeenCalledWith(canvas, 10, 20, 160, 32, 0, 0, 160, 32);
    expect(recognize).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  });
});
