import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  extensionIdOf,
  freePort,
  launchWithExtension,
  startReasoner,
  type Reasoner,
} from "./harness";

/**
 * Phase 2.5: what the vision pass actually costs, on this machine, in a real browser.
 *
 * Everything here is wall clock and resident memory of the running browser - no
 * simulation, no jsdom, no stubbed model. The pass under measurement is the same one a
 * task runs: screenshot, decode to CSS pixels, YuNet over the whole viewport, OCR over
 * every region the DOM left blank.
 *
 * Numbers land in `test-results/vision-benchmark.json` and are transcribed into
 * docs/BENCHMARKS.md. They describe one device; Phase 8.5 repeats this across tiers.
 */

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "..", "dist", "chrome");
const repoRoot = resolve(here, "..", "..");
const outputDir = resolve(here, "..", "test-results");

/** How many warm passes to time. The median of these is the reported figure. */
const WARM_PASSES = 7;

let context: BrowserContext;
let fixtures: Server;
let fixtureUrl = "";
let extensionId = "";
let reasoner: Reasoner;
let profileDir = "";

interface PassTiming {
  totalMs: number;
  decodeMs: number;
  detectMs: number;
  ocrMs: number;
  faces: number;
  regions: number;
}

test.beforeAll(async () => {
  expect(
    existsSync(join(extensionPath, "manifest.json")),
    "Run `npm run build:chrome` before the benchmark",
  ).toBe(true);

  const port = await freePort();
  fixtures = createServer((request, response) => {
    if ((request.url ?? "").startsWith("/applicant.png")) {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(readFileSync(join(repoRoot, "tests", "dataset", "faces", "chawla.png")));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(readFileSync(join(here, "fixtures", "claims-review.html")));
  });
  await new Promise<void>((done) => fixtures.listen(port, "127.0.0.1", done));
  fixtureUrl = `http://127.0.0.1:${port}/claims`;

  reasoner = await startReasoner();
  profileDir = mkdtempSync(join(tmpdir(), "privagent-bench-"));
  context = await launchWithExtension({ extensionPath, userDataDir: profileDir });
  extensionId = await extensionIdOf(context);
});

test.afterAll(async () => {
  reasoner?.stop();
  await context?.close();
  await new Promise<void>((done) => fixtures?.close(() => done()));
});

/**
 * Resident memory of the processes belonging to *this* browser, in MB.
 *
 * Two decisions worth stating. First, the measurement comes from the operating system
 * rather than from the page: `performance.memory` and CDP's `JSHeapUsedSize` both exclude
 * WebAssembly linear memory, which is where essentially all of this pipeline's footprint
 * lives - a 27 MB ONNX runtime and a 3.9 MB OCR core - so a JS heap number would
 * understate the cost by an order of magnitude.
 *
 * Second, processes are matched by this run's profile directory. Summing every Chrome on
 * the machine was the first attempt, and it moved by 265 MB between two identical runs
 * because it was measuring the operator's other browser windows.
 */
function browserResidentMb(): number | undefined {
  if (process.platform !== "win32" || !profileDir) return undefined;
  try {
    // The path goes into a PowerShell -like pattern; only the quote needs escaping.
    const pattern = profileDir.replace(/'/g, "''");
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${pattern}*' } | Measure-Object WorkingSetSize -Sum).Sum`,
      ],
      { encoding: "utf8", timeout: 60_000 },
    ).trim();
    const bytes = Number(output);
    return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 / 1024) : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the stage breakdown the pipeline itself recorded in the audit trail. */
function parsePass(observe: string): PassTiming | undefined {
  const match =
    /vision read (\d+) region\(s\), found (\d+) face\(s\) and masked \d+ pixel\(s\) in (\d+) ms \[decode (\d+), detect (\d+), ocr (\d+)\]/.exec(
      observe,
    );
  if (!match) return undefined;
  return {
    regions: Number(match[1]),
    faces: Number(match[2]),
    totalMs: Number(match[3]),
    decodeMs: Number(match[4]),
    detectMs: Number(match[5]),
    ocrMs: Number(match[6]),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

async function openPopup(): Promise<Page> {
  const opener = await context.newPage();
  const popupUrl = `chrome-extension://${extensionId}/src/ui/popup.html`;
  await opener.goto(popupUrl);
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    opener.evaluate(
      (url) =>
        (
          globalThis as unknown as { chrome: { windows: { create(options: unknown): void } } }
        ).chrome.windows.create({ url, type: "popup", width: 460, height: 760 }),
      popupUrl,
    ),
  ]);
  await opener.close();
  await popup.waitForLoadState();

  // Point it at this run's reasoner, without focusing the window: a focused popup would
  // occlude the page under test, and an occluded page produces no frames to capture.
  await popup.locator("#settings > summary").dispatchEvent("click");
  await popup.locator("#server").fill(reasoner.url, { force: true });
  await popup.locator("#save-server").dispatchEvent("click");
  return popup;
}

test("measures vision-pass latency and memory on a page with a photo and a canvas", async () => {
  const baselineMb = browserResidentMb();

  // The service worker logs what the warm-up cost, which is what makes the cold number
  // attributable rather than merely large.
  const workerLogs: string[] = [];
  for (const worker of context.serviceWorkers()) {
    worker.on("console", (message) => workerLogs.push(message.text()));
  }
  context.on("serviceworker", (worker) =>
    worker.on("console", (message) => workerLogs.push(message.text())),
  );

  const page = await context.newPage();
  await page.goto(fixtureUrl);
  await expect(page.locator("#claim-chart")).toBeVisible();

  // Before the popup exists nothing has asked for vision, so no model has loaded: this is
  // the browser with the extension installed and the page open, and nothing more.
  const beforeVisionMb = browserResidentMb();

  const popup = await openPopup();

  const passes: PassTiming[] = [];
  const seenTaskIds = new Set<string>();
  let coldPass: PassTiming | undefined;
  let coldWallMs = 0;
  const warmWallMs: number[] = [];

  // The page under test stays in front for the whole benchmark, and the popup is driven
  // without focusing it. Focusing the popup window would occlude the page, and an occluded
  // window produces no frames for `captureVisibleTab` to return - the capture then blocks
  // rather than failing, and the benchmark measures a deadlock instead of a pipeline.
  await page.bringToFront();

  for (let run = 0; run <= WARM_PASSES; run += 1) {
    // Chrome rate-limits `captureVisibleTab` to a couple of calls per second. The
    // extension retries once when it hits that, but a benchmark that spent half its runs
    // measuring the retry would be measuring Chrome's quota, not this pipeline.
    if (run > 0) await popup.waitForTimeout(1_500);
    const startedAt = Date.now();
    await popup.locator("#task").fill("approve claim", { force: true });
    await popup.locator("#run").dispatchEvent("click");
    await expect(popup.locator("#status")).toHaveAttribute("data-state", "running");
    // Keep the page compositing: an occluded window yields no frames to capture, and the
    // pass would then be measuring the timeout rather than the pipeline.
    await page.bringToFront();
    await expect(popup.locator("#status")).toHaveAttribute("data-state", "done", {
      timeout: 180_000,
    });
    const wallMs = Date.now() - startedAt;

    // Each run must be a *new* task, or the timings below are the previous run's, read
    // again. That is exactly what the first version of this benchmark reported.
    const taskId = await popup.locator("#status").getAttribute("data-task-id");
    expect(seenTaskIds.has(taskId ?? ""), `run ${run} re-read a previous task`).toBe(false);
    seenTaskIds.add(taskId ?? "");

    const observe = (await popup.locator("#trace-list li").first().textContent()) ?? "";
    const timing = parsePass(observe);
    expect(timing, `run ${run}: no vision timing in "${observe}"`).toBeDefined();

    // Run 0 is the cold pass: it also pays for loading the ONNX runtime, the detector and
    // the OCR language data. It is reported separately rather than folded into a median
    // it would dominate.
    if (run === 0) {
      coldPass = timing;
      coldWallMs = wallMs;
    } else {
      passes.push(timing!);
      warmWallMs.push(wallMs);
    }
  }

  const peakMb = browserResidentMb();
  const warmUp = workerLogs.find((line) => line.includes("vision warm-up"));
  const report = {
    device: `${process.platform} ${process.arch}`,
    measuredAt: new Date().toISOString(),
    page: "claims-review fixture: one 260x320 photograph, one 420x180 canvas, 1 face",
    passes: WARM_PASSES,
    cold: coldPass,
    coldWallMs,
    warmUp,
    warm: {
      totalMs: median(passes.map((pass) => pass.totalMs)),
      decodeMs: median(passes.map((pass) => pass.decodeMs)),
      detectMs: median(passes.map((pass) => pass.detectMs)),
      ocrMs: median(passes.map((pass) => pass.ocrMs)),
      min: Math.min(...passes.map((pass) => pass.totalMs)),
      max: Math.max(...passes.map((pass) => pass.totalMs)),
      /** Whole task, popup click to rendered result: perceive, redact, reason, act. */
      endToEndWallMs: median(warmWallMs),
    },
    memory: {
      note:
        "resident set of this browser instance's own processes, OS-measured, so it " +
        "includes the WASM linear memory that performance.memory and CDP's " +
        "JSHeapUsedSize both omit. visionDeltaMb is the attributable figure.",
      browserBaselineMb: baselineMb,
      beforeVisionMb,
      peakMb,
      /** Growth from "extension loaded, page open, no vision" to "vision warm and used". */
      visionDeltaMb:
        beforeVisionMb !== undefined && peakMb !== undefined ? peakMb - beforeVisionMb : undefined,
    },
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "vision-benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));

  // The detector saw the applicant's face on every pass. A benchmark of a pipeline that
  // silently stopped perceiving would be worse than no benchmark.
  expect(passes.every((pass) => pass.faces === 1)).toBe(true);
  expect(passes).toHaveLength(WARM_PASSES);
});
