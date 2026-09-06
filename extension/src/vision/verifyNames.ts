import { NameVerifier, WordPieceTokenizer, type NameVerifyItem } from "../content/nameVerifier";
import { createVisionSession, loadLocalModel } from "../content/visionRuntime";
import { assetUrl, LOCAL_ASSETS } from "../shared/assets";
import { PrivAgentError } from "../shared/errors";
import * as ort from "onnxruntime-web";

/**
 * Hosts the NER name verifier in the extension-origin vision document.
 *
 * It lives here, next to OCR and face detection, for the same reason they do: a content
 * script belongs to the visited site's origin, so its WASM instantiation is subject to
 * that site's CSP and would fail on exactly the strictest pages. The candidate texts
 * travel one hop into this document - the same distance the screenshot travels - are
 * scored on-device, and only booleans go back.
 */

let pending: Promise<NameVerifier> | undefined;

async function sharedVerifier(): Promise<NameVerifier> {
  pending ??= (async () => {
    const [model, tokenizerJson] = await Promise.all([
      loadLocalModel(LOCAL_ASSETS.nerModel),
      loadTokenizerJson(),
    ]);
    // WASM, not WebGPU: the model is int8-quantized and its integer matmul ops are not in
    // the JSEP WebGPU coverage; on WASM a candidate scores in single-digit milliseconds.
    const { session } = await createVisionSession(model, { backend: "wasm" });
    return new NameVerifier(
      session,
      WordPieceTokenizer.fromTokenizerJson(tokenizerJson),
      ort.Tensor,
    );
  })().catch((error: unknown) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

async function loadTokenizerJson(): Promise<unknown> {
  const response = await fetch(assetUrl(LOCAL_ASSETS.nerTokenizer));
  if (!response.ok) {
    throw new PrivAgentError(
      "model_unavailable",
      `Bundled tokenizer ${LOCAL_ASSETS.nerTokenizer} could not be read (HTTP ${response.status})`,
    );
  }
  return response.json();
}

/** One boolean per candidate span per item: true = the model confirms a person here. */
export async function verifyNamesInDocument(items: NameVerifyItem[]): Promise<boolean[][]> {
  return (await sharedVerifier()).verify(items);
}
