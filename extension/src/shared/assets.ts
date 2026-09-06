/**
 * Every file local inference loads, addressed on the extension's own origin.
 *
 * `onnxruntime-web` and `tesseract.js` both resolve their WASM cores, worker script and
 * language data from `cdn.jsdelivr.net` unless told otherwise. Those defaults are
 * disqualifying here: the fetch itself would tell a third party when and where the agent
 * started perceiving. `scripts/vendor-assets.mjs` places all of them inside the built
 * extension, and these are the paths it writes.
 *
 * `webextension-polyfill` is deliberately not imported here. It throws on import outside
 * a browser extension, which would make this module - and everything downstream of it,
 * including the whole vision pipeline - unloadable in Node-hosted tests. Reading
 * `runtime.getURL` off the global is enough for a path lookup and costs nothing.
 */

export const LOCAL_ASSETS = {
  /** Directory ORT resolves `ort-wasm-*.wasm` / `.mjs` against; trailing slash required. */
  ortWasmDir: "vendor/ort/",
  /** Directory Tesseract resolves its core binaries against; trailing slash required. */
  tesseractCoreDir: "vendor/tesseract/",
  tesseractWorker: "vendor/tesseract/worker.min.js",
  /** Directory holding `<lang>.traineddata.gz`. */
  tessdataDir: "tessdata/",
  faceModel: "models/face_detection_yunet_2023mar.onnx",
  /** Token-classification model that verifies rule-detected NAME candidates. */
  nerModel: "models/tinybert_ner_int8.onnx",
  nerTokenizer: "models/tinybert_ner_tokenizer.json",
  /**
   * The interface's typeface, vendored for exactly the same reason as everything above it.
   * It is listed here rather than only in the stylesheet so the diagnostics page reports it
   * alongside the models - a font fetched from a CDN would leak the same thing an inference
   * asset would, and this list is the place that claim is checked.
   */
  uiFont: "fonts/Inter-latin.woff2",
} as const;

interface RuntimeHost {
  runtime?: { getURL?: (path: string) => string };
}

function runtimeGetUrl(): ((path: string) => string) | undefined {
  const host = globalThis as typeof globalThis & { chrome?: RuntimeHost; browser?: RuntimeHost };
  const getURL = host.chrome?.runtime?.getURL ?? host.browser?.runtime?.getURL;
  return typeof getURL === "function" ? getURL : undefined;
}

/**
 * Absolute URL for a bundled asset.
 *
 * Returns the bare relative path when there is no extension runtime - Node-hosted tests
 * load the same files from disk, and throwing there would only mean "not a browser".
 */
export function assetUrl(path: string): string {
  try {
    const url = runtimeGetUrl()?.(path);
    if (typeof url === "string" && url.length > 0) return url;
  } catch {
    // Not running inside an extension; fall through to the relative path.
  }
  return path;
}

/** True when running with an extension runtime that can serve the vendored assets. */
export function hasExtensionOrigin(): boolean {
  try {
    return typeof runtimeGetUrl()?.("") === "string";
  } catch {
    return false;
  }
}
