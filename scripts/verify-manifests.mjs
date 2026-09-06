/**
 * Asserts the per-target manifests carry the fields each browser actually requires.
 *
 * Chrome and Firefox disagree on the MV3 background shape, and a wrong one fails only at
 * load time in a real browser - which CI cannot yet do. This check is the stand-in until
 * the Stage 3 browser smoke tests exist.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

/**
 * The version a packaged `.xpi` is named from is the manifest's, not the package's. When
 * the two drift, `npm run package:firefox` silently ships an artefact whose filename claims
 * a version the build does not carry - which happened once, and is cheap to prevent.
 */
const packageVersion = JSON.parse(
  readFileSync(join(root, "extension", "package.json"), "utf8"),
).version;

function check(condition, message) {
  if (!condition) failures.push(message);
}

for (const target of ["chrome", "firefox"]) {
  const path = join(root, "extension", "dist", target, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));

  check(
    manifest.manifest_version === 3,
    `${target}: expected manifest_version 3`,
  );
  check(
    manifest.version === packageVersion,
    `${target}: manifest version ${manifest.version} does not match package.json ${packageVersion}`,
  );
  check(
    manifest.permissions?.includes("tabs"),
    `${target}: 'tabs' permission is required for captureVisibleTab`,
  );
  check(
    manifest.content_security_policy?.extension_pages?.includes(
      "wasm-unsafe-eval",
    ),
    `${target}: extension_pages CSP must allow wasm-unsafe-eval for local inference`,
  );

  // Local inference reads its WASM cores, model and language data off the extension
  // origin from the content script's isolated world. A content script can only fetch
  // extension files that are declared web-accessible, so a missing entry here does not
  // fail the build - it fails at perception time, in the user's browser, as a CORS-ish
  // "resource not allowed" that looks nothing like its cause.
  const accessible = (manifest.web_accessible_resources ?? []).flatMap(
    (entry) => entry.resources ?? [],
  );
  for (const resource of [
    "vendor/ort/*",
    "vendor/tesseract/*",
    "models/*",
    "tessdata/*",
  ]) {
    check(
      accessible.includes(resource),
      `${target}: web_accessible_resources must include ${resource} for local inference`,
    );
  }

  // And the files themselves must actually be in the package: nothing is fetched at
  // runtime, so an absent asset is an absent capability.
  for (const file of [
    "vendor/ort/ort-wasm-simd-threaded.jsep.wasm",
    "vendor/tesseract/worker.min.js",
    "models/face_detection_yunet_2023mar.onnx",
    "tessdata/eng.traineddata.gz",
  ]) {
    check(
      existsSync(join(root, "extension", "dist", target, file)),
      `${target}: ${file} is missing from the build (run \`npm run vendor:assets\`)`,
    );
  }

  if (target === "chrome") {
    check(
      typeof manifest.background?.service_worker === "string",
      "chrome: MV3 requires background.service_worker",
    );
    check(
      manifest.background?.scripts === undefined,
      "chrome: background.scripts is not valid in Chrome MV3",
    );
  } else {
    check(
      Array.isArray(manifest.background?.scripts),
      "firefox: MV3 requires background.scripts (an event page), not a service worker",
    );
    check(
      manifest.background?.service_worker === undefined,
      "firefox: background.service_worker is not supported",
    );
    check(
      typeof manifest.browser_specific_settings?.gecko?.id === "string",
      "firefox: browser_specific_settings.gecko.id is required",
    );
  }
}

if (failures.length > 0) {
  console.error(
    `Manifest validation failed:\n${failures.map((line) => `  - ${line}`).join("\n")}`,
  );
  process.exit(1);
}

console.log("Both manifests are valid for their target browser.");
