import * as ort from "onnxruntime-web";
import { assetUrl, hasExtensionOrigin, LOCAL_ASSETS } from "../shared/assets";
import { CapabilityUnavailableError, PrivAgentError } from "../shared/errors";

export type VisionBackend = "webgpu" | "wasm";

export interface VisionSession {
  backend: VisionBackend;
  session: ort.InferenceSession;
}

/** What a model can be loaded from: bundled bytes, or an extension-origin URL. */
export type ModelSource = string | Uint8Array;

export interface OrtSessionFactory {
  InferenceSession: {
    create(
      model: ModelSource,
      options: { executionProviders: VisionBackend[] },
    ): Promise<ort.InferenceSession>;
  };
}

/**
 * ORT's own `create` is overloaded on `string` vs `Uint8Array` rather than accepting the
 * union, so the union is narrowed once here instead of at all three call sites.
 */
function createSession(
  runtime: OrtSessionFactory,
  model: ModelSource,
  backend: VisionBackend,
): Promise<ort.InferenceSession> {
  return runtime.InferenceSession.create(model as Uint8Array & string, {
    executionProviders: [backend],
  });
}

let configured = false;

/**
 * Points ONNX Runtime at the WASM binaries bundled with the extension.
 *
 * Without this, ORT resolves `ort-wasm-simd-threaded.jsep.wasm` from jsDelivr the first
 * time a session is created - a network request to a third party, made at the exact
 * moment the user asks the agent to look at their screen. `vendor-assets.mjs` copies the
 * binary into the package and this points the loader at it.
 *
 * Threads stay at one deliberately. Multi-threaded WASM needs `SharedArrayBuffer`, which
 * needs cross-origin isolation, which a content script running in someone else's page
 * cannot have. Asking for more threads would not fail loudly - ORT would warn and silently
 * drop to one anyway.
 */
export function configureLocalRuntime(): void {
  if (configured || !hasExtensionOrigin()) return;
  ort.env.wasm.wasmPaths = assetUrl(LOCAL_ASSETS.ortWasmDir);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  configured = true;
}

/** Test seam: forget that the runtime was configured. */
export function resetLocalRuntimeForTesting(): void {
  configured = false;
}

function webGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export interface VisionSessionOptions {
  /** Force one backend instead of trying WebGPU first. Used by the diagnostics probe. */
  backend?: VisionBackend;
  /** Injectable ORT, so the selection logic can be tested without loading a model. */
  runtime?: OrtSessionFactory;
}

/**
 * Prefer local WebGPU inference and safely retry with local WASM when it is unavailable
 * or fails to initialize. No model input or inference result leaves the browser.
 */
export async function createVisionSession(
  model: ModelSource,
  optionsOrRuntime: VisionSessionOptions | OrtSessionFactory = {},
): Promise<VisionSession> {
  const options: VisionSessionOptions =
    "InferenceSession" in optionsOrRuntime
      ? { runtime: optionsOrRuntime as OrtSessionFactory }
      : (optionsOrRuntime as VisionSessionOptions);
  const runtime = options.runtime ?? ort;
  configureLocalRuntime();

  if (options.backend) {
    return {
      backend: options.backend,
      session: await createSession(runtime, model, options.backend),
    };
  }

  if (webGpuAvailable()) {
    try {
      return { backend: "webgpu", session: await createSession(runtime, model, "webgpu") };
    } catch (error) {
      console.warn("PrivAgent WebGPU vision initialization failed; using WASM fallback.", error);
    }
  }

  return { backend: "wasm", session: await createSession(runtime, model, "wasm") };
}

const modelCache = new Map<string, Promise<Uint8Array>>();

/**
 * Reads a bundled model off the extension's own origin.
 *
 * Cached because a model is tens to hundreds of kilobytes and a task may perceive the
 * screen repeatedly; re-reading it per pass is pure latency against the 15% budget.
 */
export async function loadLocalModel(path: string): Promise<Uint8Array> {
  const url = assetUrl(path);
  const cached = modelCache.get(url);
  if (cached) return cached;

  const pending = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new PrivAgentError(
        "model_unavailable",
        `Bundled model ${path} could not be read from the extension (HTTP ${response.status})`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  })().catch((error: unknown) => {
    modelCache.delete(url);
    throw error;
  });

  modelCache.set(url, pending);
  return pending;
}

export interface BackendReport {
  backend: VisionBackend;
  available: boolean;
  /** Wall-clock milliseconds for session creation plus one inference pass. */
  millis?: number;
  detail?: string;
}

/**
 * Runs the shipped face model once on each backend and reports what actually worked.
 *
 * Deliberately not a feature-detection check: `'gpu' in navigator` is true on machines
 * where adapter creation then fails, and a capability claim that has never executed a
 * model is not evidence. This is what the diagnostics page and the browser test both read.
 */
export async function probeVisionBackends(
  modelPath: string = LOCAL_ASSETS.faceModel,
  input?: () => Record<string, ort.Tensor>,
): Promise<BackendReport[]> {
  const model = await loadLocalModel(modelPath);
  const feed = input ?? (() => ({ input: blankFaceModelInput() }));
  const reports: BackendReport[] = [];

  for (const backend of ["webgpu", "wasm"] as const) {
    if (backend === "webgpu" && !webGpuAvailable()) {
      reports.push({ backend, available: false, detail: "navigator.gpu is not present" });
      continue;
    }
    const started = performance.now();
    try {
      const { session } = await createVisionSession(model, { backend });
      await session.run(feed());
      reports.push({ backend, available: true, millis: Math.round(performance.now() - started) });
      await session.release?.();
    } catch (error) {
      reports.push({
        backend,
        available: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!reports.some((report) => report.available)) {
    throw new CapabilityUnavailableError(
      "local-inference",
      reports.map((report) => `${report.backend}: ${report.detail ?? "failed"}`).join("; "),
    );
  }
  return reports;
}

/** The shipped detector's fixed input geometry: NCHW, 640x640, BGR, 0-255. */
export const FACE_MODEL_INPUT_SIZE = 640;

function blankFaceModelInput(): ort.Tensor {
  const side = FACE_MODEL_INPUT_SIZE;
  return new ort.Tensor("float32", new Float32Array(3 * side * side), [1, 3, side, side]);
}
