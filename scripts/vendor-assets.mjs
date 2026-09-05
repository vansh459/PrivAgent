/**
 * Copies every runtime asset the extension needs into `extension/public/`, which Vite
 * emits verbatim into the build.
 *
 * The point is that PrivAgent never fetches anything at runtime. `onnxruntime-web` and
 * `tesseract.js` both default to a CDN (`cdn.jsdelivr.net`) for their WASM cores, their
 * worker script and their language data. A tool whose entire claim is "your screen never
 * leaves the device" cannot make a request to a third party the moment it starts
 * perceiving - that request alone reveals which pages the user is on, before a single
 * pixel is read. Every one of those assets is therefore served from the extension's own
 * origin.
 *
 * The WASM binaries come from node_modules (large, regenerable, gitignored). The two
 * model/data files are committed under `extension/assets/`, so a clean clone builds
 * offline, and their SHA-256 digests are checked here against the pinned values below -
 * a model swapped in transit is a silent, total compromise of local inference.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "extension");
const modules = join(extension, "node_modules");
const publicDir = join(extension, "public");

/**
 * `.jsep.wasm` is the single build that carries both execution providers: the WebGPU
 * (JSEP) kernels and the plain WASM ones. Shipping it alone keeps one 27 MB binary in the
 * package instead of two, and is what makes the WebGPU-to-WASM fallback a runtime choice
 * rather than a build-time one.
 */
const ORT_FILES = [
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
];

/**
 * Tesseract's worker script plus every LSTM core it might choose at runtime.
 *
 * `tesseract.js` feature-detects relaxed SIMD, then plain SIMD, then neither, and
 * `importScripts` whichever core matches - so all three have to be present or OCR fails
 * on exactly the devices whose feature set we guessed wrong. That failure mode is not
 * hypothetical: shipping only the SIMD core made Chrome 141 ask for the relaxed-SIMD one
 * and die with `Failed to execute 'importScripts'`.
 *
 * These are the `.wasm.js` builds, which carry the binary inline as base64; the bare
 * `.wasm` files next to them are never requested on this path and are not copied.
 */
const TESSERACT_FILES = [
  "tesseract.js/dist/worker.min.js",
  "tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js",
  "tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
  "tesseract.js-core/tesseract-core-lstm.wasm.js",
];

/** Committed assets, with the digest each must have. */
const PINNED = [
  {
    from: "assets/models/face_detection_yunet_2023mar.onnx",
    to: "models/face_detection_yunet_2023mar.onnx",
    sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    source:
      "opencv/opencv_zoo @ main, models/face_detection_yunet/face_detection_yunet_2023mar.onnx (MIT)",
  },
  {
    from: "assets/tessdata/eng.traineddata.gz",
    to: "tessdata/eng.traineddata.gz",
    sha256: "18c1ac52b75e35d44735fb6c2a60acfaf23033524653200738e98f0243edb75b",
    source:
      "tessdata_fast 4.0.0 'eng' via tessdata.projectnaptha.com (Apache-2.0)",
  },
];

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Skips work when the destination already matches, so `npm run build` stays fast. */
function copyIfChanged(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to) && statSync(to).size === statSync(from).size) return false;
  copyFileSync(from, to);
  return true;
}

let copied = 0;
const missing = [];

for (const file of ORT_FILES) {
  const from = join(modules, "onnxruntime-web", "dist", file);
  if (!existsSync(from)) {
    missing.push(`onnxruntime-web/dist/${file}`);
    continue;
  }
  if (copyIfChanged(from, join(publicDir, "vendor", "ort", file))) copied += 1;
}

for (const file of TESSERACT_FILES) {
  const source = join(modules, file);
  if (!existsSync(source)) {
    missing.push(file);
    continue;
  }
  const name = file.slice(file.lastIndexOf("/") + 1);
  if (copyIfChanged(source, join(publicDir, "vendor", "tesseract", name)))
    copied += 1;
}

for (const asset of PINNED) {
  const from = join(extension, asset.from);
  if (!existsSync(from)) {
    missing.push(asset.from);
    continue;
  }
  const actual = digest(from);
  if (actual !== asset.sha256) {
    console.error(
      `\nAsset digest mismatch for ${asset.from}\n  expected ${asset.sha256}\n  actual   ${actual}\n  source   ${asset.source}\n`,
    );
    process.exit(1);
  }
  if (copyIfChanged(from, join(publicDir, asset.to))) copied += 1;
}

if (missing.length > 0) {
  console.error(
    `\nMissing vendored assets:\n${missing.map((name) => `  - ${name}`).join("\n")}\n` +
      `Run \`npm ci --prefix extension\` and re-run this script.\n`,
  );
  process.exit(1);
}

console.log(
  `Vendored local inference assets into extension/public (${copied} file(s) written, ${PINNED.length} digest(s) verified).`,
);
