import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { extensionIdOf, launchWithExtension } from "./harness";

/**
 * Phase 2.1 in a real browser: does the shipped model actually run here, on each backend,
 * without reaching the network?
 *
 * Every claim in this file is one a unit test cannot make. `'gpu' in navigator` is a
 * feature flag, not evidence that a graph executed; and the CDN question - whether ONNX
 * Runtime quietly fetched its WASM core from jsDelivr - is only observable by watching
 * what the browser actually requested.
 */

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "..", "dist", "chrome");

let context: BrowserContext;
let extensionId = "";
/** Every URL the browser requested while the diagnostics page ran. */
let requested: string[] = [];

test.beforeAll(async () => {
  expect(
    existsSync(resolve(extensionPath, "manifest.json")),
    "Run `npm run build:chrome` before the e2e suite",
  ).toBe(true);
  expect(
    existsSync(resolve(extensionPath, "models", "face_detection_yunet_2023mar.onnx")),
    "Run `node scripts/vendor-assets.mjs` before the e2e suite",
  ).toBe(true);

  // SwiftShader gives WebGPU a software adapter, so the WebGPU arm is exercised on CI
  // runners and laptops with no usable GPU instead of silently reporting "unavailable".
  context = await launchWithExtension({
    extensionPath,
    args: ["--enable-unsafe-swiftshader"],
  });
  extensionId = await extensionIdOf(context);
});

test.afterAll(async () => {
  await context?.close();
});

async function openDiagnostics(prepare?: (page: Page) => Promise<void>): Promise<Page> {
  const page = await context.newPage();
  requested = [];
  page.on("request", (request) => requested.push(request.url()));
  if (prepare) await prepare(page);
  await page.goto(`chrome-extension://${extensionId}/src/ui/diagnostics.html`);
  await expect(page.locator("#probe-status")).toHaveAttribute("data-state", "done", {
    timeout: 60_000,
  });
  return page;
}

async function backends(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const rows: Record<string, string> = {};
    for (const item of document.querySelectorAll("#backend-list li")) {
      rows[item.querySelector(".stage")?.textContent ?? ""] =
        `${item.getAttribute("data-ok")}:${item.lastElementChild?.textContent ?? ""}`;
    }
    return rows;
  });
}

test("runs the bundled model on both the WebGPU and WASM backends", async () => {
  const page = await openDiagnostics();
  const rows = await backends(page);

  expect(rows["webgpu"], "WebGPU inference did not succeed").toMatch(/^true:ran in \d+ ms$/);
  expect(rows["wasm"], "WASM inference did not succeed").toMatch(/^true:ran in \d+ ms$/);
});

test("falls back to WASM in a browser without WebGPU", async () => {
  // Removing the accessor from the prototype is what a browser without WebGPU looks like:
  // `'gpu' in navigator` becomes false, which is the condition the runtime branches on.
  const page = await openDiagnostics(async (target) => {
    await target.addInitScript(() => {
      delete (Navigator.prototype as unknown as Record<string, unknown>)["gpu"];
    });
  });
  const rows = await backends(page);

  expect(rows["webgpu"]).toBe("false:navigator.gpu is not present");
  expect(rows["wasm"], "the WASM fallback must still run the model").toMatch(
    /^true:ran in \d+ ms$/,
  );
});

test("reads ten canvas samples at or above 85% character accuracy", async () => {
  const page = await openDiagnostics();

  await page.click("#run-ocr");
  await expect(page.locator("#ocr-status")).toHaveAttribute("data-state", "done", {
    timeout: 120_000,
  });

  const mean = Number(await page.locator("#ocr-status").getAttribute("data-accuracy"));
  const samples = await page.evaluate(() =>
    [...document.querySelectorAll("#ocr-list li")].map((item) => ({
      id: item.querySelector(".stage")?.textContent ?? "",
      detail: item.lastElementChild?.textContent ?? "",
    })),
  );

  console.log(`OCR self-test: mean ${(mean * 100).toFixed(1)}%`);
  for (const sample of samples) console.log(`  ${sample.id}: ${sample.detail}`);

  expect(samples).toHaveLength(10);
  expect(mean, "mean character accuracy across the ten samples").toBeGreaterThanOrEqual(0.85);

  // OCR ran with no CDN reachable from this page: the worker, the WASM core and the
  // language data were all served by the extension.
  const external = requested.filter((url) => !url.startsWith(`chrome-extension://${extensionId}/`));
  expect(external, `unexpected non-extension requests: ${external.join(", ")}`).toEqual([]);
});

test("loads every inference asset from the extension, never from a CDN", async () => {
  const page = await openDiagnostics();

  const external = requested.filter((url) => !url.startsWith(`chrome-extension://${extensionId}/`));
  expect(external, `unexpected non-extension requests: ${external.join(", ")}`).toEqual([]);

  // And the assets it did load are the vendored ones, served locally at full size.
  const rows = await page.evaluate(() => {
    const entries: Record<string, string> = {};
    for (const item of document.querySelectorAll("#asset-list li")) {
      entries[item.querySelector(".stage")?.textContent ?? ""] =
        item.lastElementChild?.textContent ?? "";
    }
    return entries;
  });
  expect(rows["faceModel"]).toBe("232589 bytes, local");
  expect(rows["tesseractWorker"]).toMatch(/^\d{6} bytes, local$/);
});
