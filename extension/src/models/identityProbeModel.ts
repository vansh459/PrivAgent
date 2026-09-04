/**
 * A tiny ONNX Identity graph (float32[1] -> float32[1]) used to verify that the
 * bundled runtime can execute a local model. It contains no screen data and is
 * intentionally kept in source so the extension never fetches a model for the
 * startup capability check.
 */
export const IDENTITY_PROBE_MODEL = new Uint8Array([
  8, 7, 58, 80, 10, 25, 10, 5, 105, 110, 112, 117, 116, 18, 6, 111, 117, 116, 112, 117, 116, 34, 8,
  73, 100, 101, 110, 116, 105, 116, 121, 18, 8, 105, 100, 101, 110, 116, 105, 116, 121, 90, 19, 10,
  5, 105, 110, 112, 117, 116, 18, 10, 10, 8, 8, 1, 18, 4, 10, 2, 8, 1, 98, 20, 10, 6, 111, 117, 116,
  112, 117, 116, 18, 10, 10, 8, 8, 1, 18, 4, 10, 2, 8, 1, 66, 2, 16, 13,
]);
