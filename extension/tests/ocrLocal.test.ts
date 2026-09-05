import { beforeEach, describe, expect, it, vi } from "vitest";

const createWorker = vi.fn(async () => ({
  recognize: vi.fn(async () => ({ data: { text: "x", confidence: 90 } })),
  terminate: vi.fn(async () => undefined),
}));
vi.mock("tesseract.js", () => ({
  createWorker,
  OEM: { LSTM_ONLY: 1 },
}));

const { createLocalOcrWorker, recognizeRegions, releaseSharedOcrWorker, sharedOcrWorker } =
  await import("../src/content/ocr");
const { runOcrSelfTest, OCR_SAMPLES } = await import("../src/content/ocrSelfTest");

/** A 2D context stub: jsdom has no canvas backend, and none of this needs real pixels. */
function stubCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    set fillStyle(_value: string) {},
    set font(_value: string) {},
    set textBaseline(_value: string) {},
  } as unknown as CanvasRenderingContext2D);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://abc/${path}` },
  });
});

describe("createLocalOcrWorker", () => {
  it("resolves its worker, core and language data on the extension origin", async () => {
    await createLocalOcrWorker();

    const [, , options] = createWorker.mock.calls[0] as unknown as [
      string,
      number,
      Record<string, unknown>,
    ];
    for (const key of ["workerPath", "corePath", "langPath"]) {
      expect(String(options[key]), key).toMatch(/^chrome-extension:\/\/abc\//);
    }
    // A blob-URL worker would be created on the *page's* origin, where the visited site's
    // CSP applies and where the extension has no business running.
    expect(options["workerBlobURL"]).toBe(false);
  });

  it("passes no option that could resolve to a remote host", async () => {
    await createLocalOcrWorker();
    const [, , options] = createWorker.mock.calls[0] as unknown as [
      string,
      number,
      Record<string, unknown>,
    ];
    for (const value of Object.values(options)) {
      if (typeof value === "string") expect(value).not.toMatch(/^https?:|cdn|jsdelivr/);
    }
  });
});

describe("recognizeRegions", () => {
  it("reads every region with a single worker and terminates it once", async () => {
    const recognize = vi.fn(async () => ({ data: { text: " label ", confidence: 91 } }));
    const terminate = vi.fn(async () => undefined);
    const factory = vi.fn(async () => ({ recognize, terminate }));
    stubCanvas();

    const results = await recognizeRegions(
      document.createElement("canvas"),
      [{ bbox: [0, 0, 10, 10] }, { bbox: [0, 10, 10, 10] }, { bbox: [0, 20, 10, 10] }],
      factory,
    );

    expect(results).toEqual([
      { text: "label", confidence: 91 },
      { text: "label", confidence: 91 },
      { text: "label", confidence: 91 },
    ]);
    // The point of the batch call: worker startup is paid once, not per region.
    expect(factory).toHaveBeenCalledTimes(1);
    expect(recognize).toHaveBeenCalledTimes(3);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("starts no worker at all when there is nothing to read", async () => {
    const factory = vi.fn();
    await expect(recognizeRegions(document.createElement("canvas"), [], factory)).resolves.toEqual(
      [],
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it("terminates the worker even when a region fails", async () => {
    const terminate = vi.fn(async () => undefined);
    const factory = vi.fn(async () => ({
      recognize: vi.fn(async () => {
        throw new Error("core crashed");
      }),
      terminate,
    }));
    stubCanvas();

    await expect(
      recognizeRegions(document.createElement("canvas"), [{ bbox: [0, 0, 4, 4] }], factory),
    ).rejects.toThrow("core crashed");
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});

describe("sharedOcrWorker", () => {
  it("starts one worker and hands the same one back to every caller", async () => {
    const worker = { recognize: vi.fn(), terminate: vi.fn(async () => undefined) };
    const factory = vi.fn(async () => worker);

    const [first, second] = await Promise.all([sharedOcrWorker(factory), sharedOcrWorker(factory)]);

    expect(first).toBe(worker);
    expect(second).toBe(worker);
    // Startup is ~2 seconds of WASM instantiation and language-data parsing; paying it
    // once per task would be most of the end-to-end latency budget.
    expect(factory).toHaveBeenCalledTimes(1);
    await releaseSharedOcrWorker();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed start, so a later call can retry", async () => {
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error("core missing"))
      .mockResolvedValue({ recognize: vi.fn(), terminate: vi.fn(async () => undefined) });

    await expect(sharedOcrWorker(factory)).rejects.toThrow("core missing");
    await expect(sharedOcrWorker(factory)).resolves.toBeDefined();
    await releaseSharedOcrWorker();
  });
});

describe("runOcrSelfTest", () => {
  it("scores each sample against its known text and averages them", async () => {
    stubCanvas();
    const reads = ["Download Report", "wrong"];
    let index = 0;
    const factory = vi.fn(async () => ({
      recognize: vi.fn(async () => ({
        data: { text: reads[index++] ?? "", confidence: 80 },
      })),
      terminate: vi.fn(async () => undefined),
    }));

    const report = await runOcrSelfTest(OCR_SAMPLES.slice(0, 2), factory);

    expect(report.samples[0]).toMatchObject({ id: "button-label", accuracy: 1 });
    expect(report.samples[1]!.accuracy).toBeLessThan(0.5);
    expect(report.meanAccuracy).toBeCloseTo(
      (report.samples[0]!.accuracy + report.samples[1]!.accuracy) / 2,
      6,
    );
    expect(report.millis).toBeGreaterThanOrEqual(0);
  });

  it("ships exactly the ten samples the accuracy criterion is stated over", () => {
    expect(OCR_SAMPLES).toHaveLength(10);
    expect(new Set(OCR_SAMPLES.map((sample) => sample.id)).size).toBe(10);
  });
});
