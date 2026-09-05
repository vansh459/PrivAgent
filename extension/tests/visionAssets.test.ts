import * as ort from "onnxruntime-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { configureLocalRuntime, loadLocalModel, probeVisionBackends, resetLocalRuntimeForTesting } =
  await import("../src/content/visionRuntime");
const { LOCAL_ASSETS } = await import("../src/shared/assets");

beforeEach(() => {
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://abc/${path}` },
  });
  resetLocalRuntimeForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runtime configuration", () => {
  it("points ONNX Runtime at the extension's own copy of the WASM core", () => {
    configureLocalRuntime();
    expect(ort.env.wasm.wasmPaths).toBe(`chrome-extension://abc/${LOCAL_ASSETS.ortWasmDir}`);
  });

  it("asks for a single thread, because a content script is never cross-origin isolated", () => {
    configureLocalRuntime();
    expect(ort.env.wasm.numThreads).toBe(1);
    expect(ort.env.wasm.proxy).toBe(false);
  });
});

describe("loadLocalModel", () => {
  it("reads the model from the extension origin and caches it across calls", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetchMock);

    const first = await loadLocalModel("models/cached.onnx");
    const second = await loadLocalModel("models/cached.onnx");

    expect(Array.from(first)).toEqual([1, 2, 3]);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("chrome-extension://abc/models/cached.onnx");
  });

  it("reports a missing model rather than handing back an empty buffer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    await expect(loadLocalModel("models/absent.onnx")).rejects.toMatchObject({
      code: "model_unavailable",
    });
  });
});

describe("probeVisionBackends", () => {
  it("reports WebGPU as absent instead of failing, and still measures WASM", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([9]))),
    );
    const run = vi.fn(async () => ({}));
    vi.spyOn(ort.InferenceSession, "create").mockResolvedValue({
      run,
    } as unknown as ort.InferenceSession);

    const reports = await probeVisionBackends("models/probe.onnx", () => ({}));

    expect(reports).toEqual([
      { backend: "webgpu", available: false, detail: "navigator.gpu is not present" },
      { backend: "wasm", available: true, millis: expect.any(Number) },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("throws when no backend can run the model, rather than reporting a healthy device", async () => {
    vi.stubGlobal("navigator", { gpu: {} });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([9]))),
    );
    vi.spyOn(ort.InferenceSession, "create").mockRejectedValue(new Error("no backend"));

    await expect(probeVisionBackends("models/probe2.onnx", () => ({}))).rejects.toMatchObject({
      code: "capability_unavailable",
      capability: "local-inference",
    });
  });
});
