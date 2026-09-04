import * as ort from "onnxruntime-web";

export type VisionBackend = "webgpu" | "wasm";

export interface VisionSession {
  backend: VisionBackend;
  session: ort.InferenceSession;
}

export interface OrtSessionFactory {
  InferenceSession: Pick<typeof ort.InferenceSession, "create">;
}

function webGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/**
 * Prefer local WebGPU inference and safely retry with local WASM when it is unavailable
 * or fails to initialize. No model input or inference result leaves the browser.
 */
export async function createVisionSession(
  modelUrl: string | Uint8Array,
  runtime: OrtSessionFactory = ort,
): Promise<VisionSession> {
  if (webGpuAvailable()) {
    try {
      return {
        backend: "webgpu",
        session: await runtime.InferenceSession.create(modelUrl, {
          executionProviders: ["webgpu"],
        }),
      };
    } catch (error) {
      console.warn("PrivAgent WebGPU vision initialization failed; using WASM fallback.", error);
    }
  }

  return {
    backend: "wasm",
    session: await runtime.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] }),
  };
}
