import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { extensionIdOf, freePort, launchWithExtension, waitFor } from "./harness";

/**
 * Build Spec Phase 8.2 and 8.4, measured over the labelled dataset in a real browser.
 *
 * Forty-two captured pages are served from `127.0.0.1`, the real extension runs a real task
 * on each, and the payload that actually leaves the browser is captured on the wire. Two
 * questions are answered from that one pass:
 *
 *   8.2 - how much of what is on the screen does the agent perceive? Transmitted marks are
 *         matched against Chrome's own accessibility tree by overlap, and the text that
 *         exists only as pixels is checked for separately, because no DOM oracle can score
 *         it.
 *   8.4 - of everything the firewall was supposed to hold back, how much got through? Every
 *         labelled value is searched for, raw, in the bytes that were sent.
 *
 * Every outbound request except to `127.0.0.1` is aborted for the duration. That keeps the
 * measurement reproducible - a snapshot that quietly fetched a live font would drift - and
 * it means a benchmark of a privacy tool cannot itself talk to anyone.
 */

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "..", "dist", "chrome");
const repoRoot = resolve(here, "..", "..");
const datasetDir = join(repoRoot, "tests", "dataset", "screens");
const resultsDir = join(repoRoot, "test-results");

/** The task is the same on every screen, and names both painted regions on purpose. */
const TASK = "check the balance due and contact details";

/** Overlap at which a transmitted mark is considered to be the oracle's element. */
const IOU_MATCH = 0.5;

/**
 * The types Phase 8.4 names as critical: "zero unredacted critical fields
 * (Aadhaar/bank/OTP/faces)". Identifiers and contact details are held to an absolute zero.
 * NAME and ADDRESS are reported separately - a rule-based recogniser with no label to go on
 * cannot promise them, and pretending otherwise in a test would be the dishonest choice.
 */
const CRITICAL = new Set(["AADHAAR", "CARD", "OTP", "PAN", "PHONE", "EMAIL"]);

/** Set to a small number to iterate on this suite without waiting for all 42 screens. */
const ONLY = process.env.PRIVAGENT_DATASET_ONLY?.split(",");

interface Truth {
  id: string;
  type: string;
  viewport: { width: number; height: number };
  elements: { oracleId: string; role: string; name: string; bbox: number[] }[];
  pii: { id: string; type: string; value: string; text: string; bbox: number[] | null }[];
  vision: {
    faces: { id: string; source: string; bbox: number[] }[];
    pixelText: { id: string; text: string; bbox: number[]; pii: { value: string } | null }[];
  };
}

interface SentMark {
  mark_id: string;
  role: string;
  text: string;
  bbox: [number, number, number, number];
}

let context: BrowserContext;
let fixtures: Server;
let proxy: Server;
let api: ChildProcess;
let baseUrl = "";
let proxyUrl = "";
let extensionId = "";
let blocked = 0;

const sentBodies: string[] = [];

function truths(): Truth[] {
  const index = JSON.parse(readFileSync(join(datasetDir, "index.json"), "utf8")) as {
    rows: { id: string }[];
  };
  return index.rows.map(
    (row) => JSON.parse(readFileSync(join(datasetDir, `${row.id}.json`), "utf8")) as Truth,
  );
}

function serverPython(): string {
  const venv =
    process.platform === "win32"
      ? join(repoRoot, "server", ".venv", "Scripts", "python.exe")
      : join(repoRoot, "server", ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return process.platform === "win32" ? "python.exe" : "python3";
}

/** Intersection over union of two `[x, y, width, height]` boxes. */
function iou(left: number[], right: number[]): number {
  const x = Math.max(left[0]!, right[0]!);
  const y = Math.max(left[1]!, right[1]!);
  const right_ = Math.min(left[0]! + left[2]!, right[0]! + right[2]!);
  const bottom = Math.min(left[1]! + left[3]!, right[1]! + right[3]!);
  if (right_ <= x || bottom <= y) return 0;
  const overlap = (right_ - x) * (bottom - y);
  return overlap / (left[2]! * left[3]! + right[2]! * right[3]! - overlap);
}

/** Levenshtein-based character accuracy, the same measure the OCR self-test uses. */
function characterAccuracy(expected: string, actual: string): number {
  const rows = expected.length + 1;
  const columns = actual.length + 1;
  const distance = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));
  for (let row = 0; row < rows; row += 1) distance[row]![0] = row;
  for (let column = 0; column < columns; column += 1) distance[0]![column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = expected[row - 1] === actual[column - 1] ? 0 : 1;
      distance[row]![column] = Math.min(
        distance[row - 1]![column]! + 1,
        distance[row]![column - 1]! + 1,
        distance[row - 1]![column - 1]! + cost,
      );
    }
  }
  return expected.length === 0
    ? 1
    : Math.max(0, 1 - distance[rows - 1]![columns - 1]! / expected.length);
}

/** Our role vocabulary against the accessibility tree's, where they differ by name only. */
const ROLE_ALIASES: Record<string, string> = {
  text_field: "textbox",
  combobox: "combobox",
};

test.beforeAll(async () => {
  expect(
    existsSync(join(extensionPath, "manifest.json")),
    "Run `npm run build:chrome` before the e2e suite",
  ).toBe(true);

  const fixturePort = await freePort();
  fixtures = createServer((request, response) => {
    const id = (request.url ?? "/").replace(/^\/+/, "").split("?")[0]!.split("#")[0]!;
    const file = join(datasetDir, `${id}.html.gz`);
    if (!existsSync(file)) {
      response.writeHead(404).end("no such screen");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(gunzipSync(readFileSync(file)));
  });
  await new Promise<void>((done) => fixtures.listen(fixturePort, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${fixturePort}`;

  const apiPort = await freePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  api = spawn(
    serverPython(),
    [
      "-m",
      "uvicorn",
      "app.main:app",
      "--app-dir",
      "server",
      "--host",
      "127.0.0.1",
      "--port",
      String(apiPort),
    ],
    { cwd: repoRoot, env: { ...process.env, PYTHONPATH: join(repoRoot, "server") } },
  );
  await waitFor(
    async () => (await fetch(`${apiUrl}/health`)).ok,
    30_000,
    "the FastAPI server to become healthy",
  );

  const proxyPort = await freePort();
  proxy = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.url?.includes("/reason")) sentBodies.push(body);
      const upstream = await fetch(`${apiUrl}${request.url}`, {
        method: request.method,
        headers: { "Content-Type": "application/json" },
        ...(request.method === "POST" ? { body } : {}),
      });
      response.writeHead(upstream.status, { "Content-Type": "application/json" });
      response.end(await upstream.text());
    });
  });
  await new Promise<void>((done) => proxy.listen(proxyPort, "127.0.0.1", done));
  proxyUrl = `http://127.0.0.1:${proxyPort}`;

  context = await launchWithExtension({
    extensionPath,
    // The dataset was annotated at 1 280 CSS pixels wide, and every ground-truth box was
    // measured in that layout. A different width would reflow the page and move all of
    // them, so the window is sized to reproduce it rather than left at Playwright's
    // default.
    args: ["--window-size=1280,1010"],
  });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("http://127.0.0.1") || url.startsWith("chrome-extension://")) {
      await route.continue();
      return;
    }
    blocked += 1;
    await route.abort();
  });
  extensionId = await extensionIdOf(context);
  expect(extensionId).toBeTruthy();
});

test.afterAll(async () => {
  await context?.close();
  api?.kill();
  await new Promise<void>((done) => proxy?.close(() => done()));
  await new Promise<void>((done) => fixtures?.close(() => done()));
});

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
  await popup.click("#settings > summary");
  await popup.fill("#server", proxyUrl);
  await popup.click("#save-server");
  await expect(popup.locator("#status")).toHaveText("Reasoner URL saved.");
  return popup;
}

async function summary(popup: Page): Promise<Record<string, string>> {
  return popup.evaluate(() => {
    const entries: Record<string, string> = {};
    const cells = document.querySelectorAll("#summary-list > *");
    for (let index = 0; index < cells.length; index += 2) {
      entries[cells[index]!.textContent ?? ""] = cells[index + 1]!.textContent ?? "";
    }
    return entries;
  });
}

test("perceives, redacts and reports across the whole labelled dataset", async () => {
  // Forty-two full pipeline runs, several of them on pages carrying dozens of images.
  test.setTimeout(45 * 60_000);

  const all = truths();
  expect(
    all.length,
    "the dataset must carry at least the 30 screens Phase 8.1 requires",
  ).toBeGreaterThanOrEqual(30);

  const wanted = ONLY ? all.filter((truth) => ONLY.includes(truth.id)) : all;
  const popup = await openPopup();
  const rows: Record<string, unknown>[] = [];
  const leaks: { screen: string; type: string; value: string }[] = [];

  for (const truth of wanted) {
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}/${truth.id}`, { waitUntil: "load", timeout: 60_000 });
      const { width, height } = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));
      expect(width, "the dataset layout depends on the window width").toBeGreaterThan(1000);

      const before = sentBodies.length;
      await popup.fill("#task", TASK);
      await popup.click("#run");
      await expect(popup.locator("#status")).toHaveAttribute("data-state", "running");
      await page.bringToFront();
      await expect(popup.locator("#status")).not.toHaveAttribute("data-state", "running", {
        timeout: 180_000,
      });

      const state = await popup.locator("#status").getAttribute("data-state");
      const counts = await summary(popup);
      // The observe line records how many visual regions this page presented and how long
      // the pass took - the numbers behind the vision result, straight from the audit trail.
      const observe = (await popup.locator("#trace-list li").first().textContent()) ?? "";
      const regionsRead = Number(/vision read (\d+) region/.exec(observe)?.[1] ?? 0);
      const visionMs = Number(/in (\d+) ms/.exec(observe)?.[1] ?? 0);
      const payload = sentBodies.slice(before).join("\n");
      const marks: SentMark[] = payload
        ? ((JSON.parse(sentBodies.at(-1)!) as { elements: SentMark[] }).elements ?? [])
        : [];

      // --- 8.2, DOM half: agreement with the accessibility oracle --------------------
      //
      // Elements the firewall deliberately withheld are removed from the denominator.
      // They were not missed; they were held back because they carried PII, which is the
      // thing Phase 8.4 measures. Counting them as perception failures would score the
      // privacy guarantee as a defect.
      const withheldBoxes = truth.pii.map((span) => span.bbox).filter(Boolean) as number[][];
      const expected = truth.elements.filter(
        (element) => !withheldBoxes.some((box) => iou(element.bbox, box) >= IOU_MATCH),
      );

      const takenMarks = new Set<string>();
      let matched = 0;
      let roleAgreed = 0;
      let nameAgreed = 0;
      for (const element of expected) {
        let best: { mark: SentMark; score: number } | undefined;
        for (const mark of marks) {
          if (takenMarks.has(mark.mark_id)) continue;
          const score = iou(element.bbox, mark.bbox);
          if (score >= IOU_MATCH && (!best || score > best.score)) best = { mark, score };
        }
        if (!best) continue;
        takenMarks.add(best.mark.mark_id);
        matched += 1;
        if ((ROLE_ALIASES[best.mark.role] ?? best.mark.role) === element.role) roleAgreed += 1;
        const ours = best.mark.text.replace(/\s+/g, " ").trim().toLowerCase();
        const theirs = element.name.replace(/\s+/g, " ").trim().toLowerCase();
        if (ours && theirs && (ours === theirs || ours.includes(theirs) || theirs.includes(ours))) {
          nameAgreed += 1;
        }
      }

      // --- 8.2, vision half: text that exists only as pixels, and faces ---------------
      const painted = truth.vision.pixelText.find((region) => region.pii === null)!;
      // Matched by rectangle, never by content. Picking the mark whose text merely looks
      // like the painted string finds the longest DOM paragraph on the page that happens to
      // contain the word "due" - which scored five real reads as zero before this was
      // fixed. The painted region has a known box; the mark that occupies it is the answer.
      const readBack = marks
        .map((mark) => ({ mark, score: iou(painted.bbox, mark.bbox) }))
        .filter((candidate) => candidate.score >= IOU_MATCH)
        .sort((left, right) => right.score - left.score)[0]?.mark.text;
      const pixelAccuracy = readBack ? characterAccuracy(painted.text, readBack.trim()) : 0;

      // --- 8.4: nothing labelled may appear raw in what was sent ----------------------
      const raw = truth.pii.filter((span) => payload.includes(span.value));
      for (const span of raw) {
        leaks.push({ screen: truth.id, type: span.type, value: span.value });
      }
      const pixelPii = truth.vision.pixelText.find((region) => region.pii !== null)!;
      const pixelLeak = payload.includes(pixelPii.pii!.value);
      if (pixelLeak) {
        leaks.push({ screen: truth.id, type: "PHONE", value: pixelPii.pii!.value });
      }

      rows.push({
        id: truth.id,
        type: truth.type,
        state,
        innerWidth: width,
        innerHeight: height,
        oracleElements: truth.elements.length,
        expectedElements: expected.length,
        withheldByDesign: truth.elements.length - expected.length,
        observed: Number(counts["Elements perceived"] ?? 0),
        transmitted: marks.length,
        matched,
        roleAgreed,
        nameAgreed,
        recall: expected.length ? matched / expected.length : 1,
        precision: marks.length ? matched / marks.length : 0,
        seenByVision: Number(counts["Seen by vision"] ?? 0),
        regionsRead,
        visionMs,
        facesDetected: Number(counts["Faces detected (never sent)"] ?? 0),
        labelledFaces: truth.vision.faces.length,
        redactedElements: Number(counts["Elements redacted"] ?? 0),
        withheldForReview: Number(counts["Withheld for review"] ?? 0),
        piiSpans: truth.pii.length,
        rawPiiInPayload: raw.length,
        pixelTextAccuracy: pixelAccuracy,
        pixelPiiLeaked: pixelLeak,
        payloadBytes: payload.length,
        // Only when a subset was asked for: the raw marks, so a screen that scores badly
        // can be diagnosed without re-running the whole set.
        ...(ONLY ? { marks: marks.slice(0, 400) } : {}),
      });
    } finally {
      await page.close();
    }
  }

  const sum = (key: string) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
  const matched = sum("matched");
  const expectedTotal = sum("expectedElements");
  const transmitted = sum("transmitted");
  const accuracies = rows.map((row) => Number(row.pixelTextAccuracy));

  const report = {
    measuredAt: new Date().toISOString(),
    task: TASK,
    screens: rows.length,
    blockedExternalRequests: blocked,
    element: {
      oracleElements: sum("oracleElements"),
      withheldByDesign: sum("withheldByDesign"),
      expected: expectedTotal,
      transmitted,
      matched,
      recall: matched / expectedTotal,
      precision: matched / transmitted,
      f1: (2 * matched) / (expectedTotal + transmitted),
      roleAgreement: sum("roleAgreed") / matched,
      nameAgreement: sum("nameAgreed") / matched,
    },
    vision: {
      screensWithPixelTextRead: accuracies.filter((value) => value > 0).length,
      meanPixelTextAccuracy: accuracies.reduce((total, value) => total + value, 0) / rows.length,
      labelledFaces: sum("labelledFaces"),
      facesDetected: sum("facesDetected"),
      regionsRead: sum("regionsRead"),
      medianVisionMs: [...rows]
        .map((row) => Number(row.visionMs))
        .sort((left, right) => left - right)[Math.floor(rows.length / 2)],
    },
    redaction: {
      piiSpans: sum("piiSpans"),
      rawPiiInPayload: sum("rawPiiInPayload"),
      elementsRedacted: sum("redactedElements"),
      elementsWithheldForReview: sum("withheldForReview"),
      criticalLeaks: leaks.filter((leak) => CRITICAL.has(leak.type)).length,
      unstructuredLeaks: leaks.filter((leak) => !CRITICAL.has(leak.type)).length,
      leaks,
    },
    rows,
  };

  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(
    join(resultsDir, "dataset-eval.json"),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );

  console.log(
    `\n${rows.length} screens | elements P ${(100 * report.element.precision).toFixed(1)}% ` +
      `R ${(100 * report.element.recall).toFixed(1)}% F1 ${(100 * report.element.f1).toFixed(1)}% | ` +
      `pixel text ${(100 * report.vision.meanPixelTextAccuracy).toFixed(1)}% | ` +
      `faces ${report.vision.facesDetected}/${report.vision.labelledFaces} | ` +
      `critical PII leaked ${report.redaction.criticalLeaks}, ` +
      `unstructured ${report.redaction.unstructuredLeaks}`,
  );

  // Phase 8.4's criterion, and the line in this file that must never be relaxed: not one
  // identifier or contact detail may appear raw in anything that was transmitted.
  expect(
    leaks.filter((leak) => CRITICAL.has(leak.type)),
    "critical PII values found in transmitted payloads",
  ).toEqual([]);
  expect(report.element.recall).toBeGreaterThan(0.5);
});
