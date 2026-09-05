import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessage = vi.fn();
vi.mock("webextension-polyfill", () => ({ default: { runtime: { sendMessage } } }));

const { analyzeInHost, warmVisionHost } = await import("../src/background/vision");

/**
 * The background worker's half of the vision pass: get a document, hand it the screenshot.
 *
 * Chrome allows exactly one offscreen document per extension and throws on a second, so
 * the interesting behaviour here is all about not creating two - and about what happens
 * on a browser that has no offscreen API at all, where Firefox's event page hosts the
 * same module itself.
 */

const regions = [
  { id: "vision_1", role: "canvas", describedText: "", bbox: [0, 0, 10, 10] },
] as never;
const viewport = { width: 800, height: 600 };
const analysis = { elements: [], faces: 0, regionsRead: 1, millis: 12 };

function offscreen(overrides: Partial<{ hasDocument: () => Promise<boolean> }> = {}) {
  const createDocument = vi.fn(async () => undefined);
  const hasDocument = vi.fn(overrides.hasDocument ?? (async () => false));
  vi.stubGlobal("chrome", { offscreen: { createDocument, hasDocument } });
  return { createDocument, hasDocument };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMessage.mockResolvedValue({ ok: true, value: analysis });
});

afterEach(() => vi.unstubAllGlobals());

describe("analyzeInHost", () => {
  it("creates the offscreen document and forwards the screenshot to it", async () => {
    const api = offscreen();

    await expect(analyzeInHost("data:image/png;base64,x", regions, viewport)).resolves.toEqual(
      analysis,
    );

    expect(api.createDocument).toHaveBeenCalledTimes(1);
    expect(api.createDocument.mock.calls[0]![0]).toMatchObject({
      url: "src/ui/offscreen.html",
      reasons: ["WORKERS"],
    });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "privagent/vision-run",
      dataUrl: "data:image/png;base64,x",
      regions,
      viewport,
    });
  });

  it("does not create a second document when one already exists", async () => {
    const api = offscreen({ hasDocument: async () => true });

    await analyzeInHost("data:image/png;base64,x", regions, viewport);

    expect(api.createDocument).not.toHaveBeenCalled();
  });

  it("tolerates losing the creation race to another task", async () => {
    // First check says "no document", creation then fails because a concurrent task got
    // there first, and the recheck confirms one exists. That is success, not failure.
    const createDocument = vi.fn(async () => {
      throw new Error("Only a single offscreen document may be created");
    });
    const hasDocument = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    vi.stubGlobal("chrome", { offscreen: { createDocument, hasDocument } });

    await expect(analyzeInHost("data:image/png;base64,x", regions, viewport)).resolves.toEqual(
      analysis,
    );
  });

  it("propagates a genuine creation failure rather than analysing nothing", async () => {
    const createDocument = vi.fn(async () => {
      throw new Error("offscreen documents are disabled by policy");
    });
    vi.stubGlobal("chrome", {
      offscreen: { createDocument, hasDocument: async () => false },
    });

    await expect(analyzeInHost("data:image/png;base64,x", regions, viewport)).rejects.toThrow(
      /disabled by policy/,
    );
  });

  it("surfaces the offscreen document's own failure", async () => {
    offscreen();
    sendMessage.mockResolvedValue({
      ok: false,
      error: { code: "capability_unavailable", message: "OCR core failed to load" },
    });

    await expect(analyzeInHost("data:image/png;base64,x", regions, viewport)).rejects.toMatchObject(
      { code: "capability_unavailable", message: "OCR core failed to load" },
    );
  });

  it("runs the analysis in place where there is no offscreen API but there is a document", async () => {
    // Firefox MV3: the background is an event page, so it hosts the analysis itself.
    vi.stubGlobal("chrome", {});

    // The call reaches the decoder and fails there - jsdom has no image decoding - which
    // is the point: it failed *in this process* rather than by messaging an offscreen
    // document this browser does not have.
    await expect(analyzeInHost("data:image/png;base64,x", [] as never, viewport)).rejects.toThrow();
    expect(
      sendMessage,
      "the Firefox path must not message an offscreen document",
    ).not.toHaveBeenCalled();
  });
});

describe("warmVisionHost", () => {
  it("creates the document and asks it to preload, before any task needs it", async () => {
    const api = offscreen();
    sendMessage.mockResolvedValue({ ok: true, value: { warm: true } });

    await warmVisionHost();

    expect(api.createDocument).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: "privagent/vision-warm" });
  });
});
