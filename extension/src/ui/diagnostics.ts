import { LOCAL_ASSETS, assetUrl } from "../shared/assets";
import { probeVisionBackends, type BackendReport } from "../content/visionRuntime";
import { runOcrSelfTest } from "../content/ocrSelfTest";
import { describeError } from "../shared/errors";

/**
 * A device-capability report, not a debug page.
 *
 * Phase 2.1 asks whether a model runs on WebGPU *and* on the WASM fallback on this
 * machine. That cannot be answered by reading `navigator.gpu`; it is only answerable by
 * running the shipped model on each backend and seeing what comes back. This page does
 * exactly that, on the extension's own origin, and is also the surface the browser test
 * asserts against - so the claim in the build spec and the thing the user can see are the
 * same measurement.
 */

const list = document.querySelector<HTMLUListElement>("#backend-list");
const assets = document.querySelector<HTMLUListElement>("#asset-list");
const status = document.querySelector<HTMLParagraphElement>("#probe-status");
const button = document.querySelector<HTMLButtonElement>("#run-probe");

function row(parent: HTMLUListElement, ok: boolean, label: string, detail: string): void {
  const item = document.createElement("li");
  item.dataset.ok = String(ok);
  const name = document.createElement("span");
  name.className = "stage";
  name.textContent = label;
  const value = document.createElement("span");
  value.className = ok ? "ok" : "bad";
  value.textContent = detail;
  item.append(name, value);
  parent.append(item);
}

function render(reports: BackendReport[]): void {
  if (!list) return;
  list.replaceChildren();
  for (const report of reports) {
    row(
      list,
      report.available,
      report.backend,
      report.available ? `ran in ${report.millis} ms` : (report.detail ?? "unavailable"),
    );
  }
}

/** Confirms each vendored file is served from this extension, which is the privacy claim. */
async function checkAssets(): Promise<void> {
  if (!assets) return;
  assets.replaceChildren();
  for (const [name, path] of Object.entries(LOCAL_ASSETS)) {
    const url = assetUrl(path.endsWith("/") ? `${path}` : path);
    if (path.endsWith("/")) {
      row(assets, true, name, url);
      continue;
    }
    try {
      const response = await fetch(url, { method: "GET" });
      const size = (await response.arrayBuffer()).byteLength;
      row(
        assets,
        response.ok,
        name,
        response.ok ? `${size} bytes, local` : `HTTP ${response.status}`,
      );
    } catch (error) {
      row(assets, false, name, describeError(error).message);
    }
  }
}

async function probe(): Promise<void> {
  if (!status || !button) return;
  button.disabled = true;
  status.textContent = "Running the bundled model on each backend...";
  try {
    render(await probeVisionBackends());
    status.textContent = "Probe complete.";
    status.dataset.state = "done";
  } catch (error) {
    status.textContent = `Probe failed: ${describeError(error).message}`;
    status.dataset.state = "failed";
  } finally {
    button.disabled = false;
  }
}

const ocrList = document.querySelector<HTMLUListElement>("#ocr-list");
const ocrStatus = document.querySelector<HTMLParagraphElement>("#ocr-status");
const ocrButton = document.querySelector<HTMLButtonElement>("#run-ocr");

/** Runs the ten-sample read-back and shows the score for each one. */
async function ocrSelfTest(): Promise<void> {
  if (!ocrList || !ocrStatus || !ocrButton) return;
  ocrButton.disabled = true;
  ocrStatus.textContent = "Rendering ten samples and reading them back locally...";
  delete ocrStatus.dataset.state;
  try {
    const report = await runOcrSelfTest();
    ocrList.replaceChildren();
    for (const sample of report.samples) {
      row(
        ocrList,
        sample.accuracy >= 0.85,
        sample.id,
        `${Math.round(sample.accuracy * 100)}% � read "${sample.actual}"`,
      );
    }
    ocrStatus.textContent =
      `Mean character accuracy ${(report.meanAccuracy * 100).toFixed(1)}% ` +
      `across ${report.samples.length} samples in ${report.millis} ms.`;
    ocrStatus.dataset.accuracy = report.meanAccuracy.toFixed(4);
    ocrStatus.dataset.state = "done";
  } catch (error) {
    ocrStatus.textContent = `OCR self-test failed: ${describeError(error).message}`;
    ocrStatus.dataset.state = "failed";
  } finally {
    ocrButton.disabled = false;
  }
}

ocrButton?.addEventListener("click", () => void ocrSelfTest());
button?.addEventListener("click", () => void probe());
void checkAssets();
void probe();
