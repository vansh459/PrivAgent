import { afterEach, describe, expect, it, vi } from "vitest";
import { createVisionSession, type OrtSessionFactory } from "../src/content/visionRuntime";

const model = new Uint8Array([1, 2, 3]);

function runtimeWith(create: ReturnType<typeof vi.fn>): OrtSessionFactory {
  return { InferenceSession: { create } } as unknown as OrtSessionFactory;
}

describe("createVisionSession", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses WebGPU when it is available and the model session initializes", async () => {
    vi.stubGlobal("navigator", { gpu: {} });
    const session = { run: vi.fn() };
    const create = vi.fn().mockResolvedValue(session);

    await expect(createVisionSession(model, runtimeWith(create))).resolves.toEqual({
      backend: "webgpu",
      session,
    });
    expect(create).toHaveBeenCalledWith(model, { executionProviders: ["webgpu"] });
  });

  it("falls back to WASM after a WebGPU initialization failure", async () => {
    vi.stubGlobal("navigator", { gpu: {} });
    const session = { run: vi.fn() };
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("WebGPU unavailable"))
      .mockResolvedValueOnce(session);

    await expect(createVisionSession(model, runtimeWith(create))).resolves.toEqual({
      backend: "wasm",
      session,
    });
    expect(create).toHaveBeenNthCalledWith(1, model, { executionProviders: ["webgpu"] });
    expect(create).toHaveBeenNthCalledWith(2, model, { executionProviders: ["wasm"] });
  });

  it("selects WASM when the browser does not expose WebGPU", async () => {
    vi.stubGlobal("navigator", {});
    const session = { run: vi.fn() };
    const create = vi.fn().mockResolvedValue(session);

    await expect(createVisionSession(model, runtimeWith(create))).resolves.toEqual({
      backend: "wasm",
      session,
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(model, { executionProviders: ["wasm"] });
  });
});
