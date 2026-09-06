import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { extensionIdOf, freePort, launchWithExtension, waitFor } from "./harness";

/**
 * Build Spec Phase 9.3 and 9.4: the demo, rehearsed by machine and recorded while it runs.
 *
 * `docs/DEMO_SCRIPT.md` is the script a person reads out. This file is that script executed
 * - the same three tasks, in the same order, on the same pages - so the flow cannot rot
 * silently between rehearsals. It runs twice in a row on purpose: a demo that works once is
 * not rehearsed, and the second pass is what catches state left behind by the first.
 *
 * The recording it produces is the Phase 9.4 backup. A video made by a command is
 * reproducible in a way a screen capture is not: if the demo changes, the backup is one
 * `npx playwright test e2e/demo.spec.ts` away from being right again. What it cannot show is
 * a person talking over it, which is the part a live demo is for.
 */

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "..", "dist", "chrome");
const repoRoot = resolve(here, "..", "..");
const videoDir = join(repoRoot, "docs", "demo");
const rawVideoDir = join(repoRoot, "extension", "test-results", "demo-video");

let context: BrowserContext;
let fixtures: Server;
let proxy: Server;
let api: ChildProcess;
let portalUrl = "";
let claimsUrl = "";
let proxyUrl = "";
let extensionId = "";

const sentBodies: string[] = [];
let forcedAction: Record<string, unknown> | undefined;

function serverPython(): string {
  const venv =
    process.platform === "win32"
      ? join(repoRoot, "server", ".venv", "Scripts", "python.exe")
      : join(repoRoot, "server", ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return process.platform === "win32" ? "python.exe" : "python3";
}

test.beforeAll(async () => {
  expect(
    existsSync(join(extensionPath, "manifest.json")),
    "Run `npm run build:chrome` before the demo rehearsal",
  ).toBe(true);

  rmSync(rawVideoDir, { recursive: true, force: true });
  mkdirSync(videoDir, { recursive: true });

  const fixturePort = await freePort();
  fixtures = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/applicant.png")) {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(readFileSync(join(repoRoot, "tests", "dataset", "faces", "chawla.png")));
      return;
    }
    const page = url.startsWith("/claims") ? "claims-review.html" : "report-portal.html";
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(readFileSync(join(here, "fixtures", page)));
  });
  await new Promise<void>((done) => fixtures.listen(fixturePort, "127.0.0.1", done));
  portalUrl = `http://127.0.0.1:${fixturePort}/portal`;
  claimsUrl = `http://127.0.0.1:${fixturePort}/claims`;

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
      if (request.url?.includes("/reason")) {
        sentBodies.push(body);
        if (forcedAction) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(forcedAction));
          return;
        }
      }
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
    recordVideo: { dir: rawVideoDir, size: { width: 1280, height: 720 } },
  });
  extensionId = await extensionIdOf(context);
});

test.afterAll(async () => {
  // Videos are only flushed to disk when the context closes.
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

async function runTask(popup: Page, page: Page, task: string): Promise<void> {
  await popup.fill("#task", task);
  await popup.click("#run");
  await expect(popup.locator("#status")).toHaveAttribute("data-state", "running");
  await page.bringToFront();
  await expect(popup.locator("#status")).toHaveAttribute("data-state", "done", {
    timeout: 120_000,
  });
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

/** One full pass of the demo script, asserted line by line. */
async function rehearse(pass: number): Promise<Record<string, unknown>> {
  const notes: Record<string, unknown> = { pass };

  // --- Act 1: a task runs, and the page is actually actuated -------------------------
  const portal = await context.newPage();
  await portal.goto(portalUrl);
  await portal.fill("#username", "shivam");
  await portal.fill("#password", "Hunter2SuperSecret");
  await expect(portal.locator("#result")).toHaveText("not clicked");

  const popup = await openPopup();
  let before = sentBodies.length;
  await runTask(popup, portal, "download report");

  await expect(portal.locator("#result")).toHaveText("downloaded");
  const first = await summary(popup);
  notes.act1 = first;

  // --- Act 2: what actually left the machine -----------------------------------------
  const payload = sentBodies.slice(before).join("\n");
  for (const secret of [
    "Hunter2SuperSecret",
    "9876543210",
    "accounts@example.com",
    "1234 5678 9012",
    "4111 1111 1111 1111",
  ]) {
    expect(payload, `the demo would have shown ${secret} on the wire`).not.toContain(secret);
  }

  before = sentBodies.length;
  await runTask(popup, portal, "request callback");
  const tokenized = sentBodies.slice(before).join("\n");
  // The one PII value the task actually needs: transmitted, but as a token.
  expect(tokenized).toContain("Request callback on [PII_PHONE_01]");
  expect(tokenized).not.toContain("9876543210");
  notes.act2 = { tokenized: true };

  // --- Act 3: the screen the DOM cannot describe -------------------------------------
  const claims = await context.newPage();
  await claims.goto(claimsUrl);
  await expect(claims.locator("#claim-chart")).toBeVisible();

  before = sentBodies.length;
  await runTask(popup, claims, "check the settlement total");
  const visionSummary = await summary(popup);
  expect(Number(visionSummary["Seen by vision"])).toBeGreaterThan(0);
  expect(Number(visionSummary["Faces detected (never sent)"])).toBe(1);

  const visionPayload = sentBodies.slice(before).join("\n");
  // Read off the screen: this string is in no text node and no attribute.
  expect(visionPayload).toContain("Settlement total");
  expect(visionPayload).not.toContain('"role":"face"');
  notes.act3 = visionSummary;

  // --- Act 4: the agent asks before doing something it should not do alone -----------
  forcedAction = {
    action: "navigate",
    target_id: null,
    params: { url: "#hijacked" },
    confidence: 0.99,
    risk: "low",
    explanation: "Taking you somewhere else entirely.",
    reasoning_trace_id: "trace_demo",
  };
  try {
    await popup.fill("#task", "download report");
    await popup.click("#run");
    await claims.bringToFront();
    await expect(claims.locator("#privagent-confirm-host")).toBeAttached({ timeout: 60_000 });
    await claims.keyboard.press("Escape");
    await expect(popup.locator("#status")).toContainText("denied_by_user", { timeout: 60_000 });
    expect(claims.url).not.toContain("hijacked");
  } finally {
    forcedAction = undefined;
  }
  notes.act4 = { denied: true };

  // --- Act 5: the trail, on the extension's own origin --------------------------------
  expect(await claims.evaluate(() => ({ ...localStorage }))).toEqual({
    "page-own-key": "page-own-value",
  });
  const stages = await popup.locator("#trace-list .stage").allTextContents();
  notes.act5 = { stages };

  await claims.close();
  await portal.close();
  await popup.close();
  return notes;
}

test("rehearses the demo script twice, end to end, and records it", async () => {
  test.setTimeout(20 * 60_000);

  const passes = [await rehearse(1), await rehearse(2)];

  mkdirSync(join(repoRoot, "test-results"), { recursive: true });
  writeFileSync(
    join(repoRoot, "test-results", "demo-rehearsal.json"),
    JSON.stringify({ rehearsedAt: new Date().toISOString(), passes }, null, 2) + "\n",
    "utf8",
  );

  // Both passes must produce the same privacy summary. A demo whose numbers move between
  // rehearsals is a demo that will move on stage.
  expect(passes[0]!.act1).toEqual(passes[1]!.act1);
  expect(passes[0]!.act3).toEqual(passes[1]!.act3);
});

test.afterAll(async () => {
  // Runs after the context has closed, so the videos exist. The longest one is the session;
  // it is kept as the backup recording and the rest are left in test-results.
  const { readdirSync, statSync } = await import("node:fs");
  if (!existsSync(rawVideoDir)) return;
  const videos = readdirSync(rawVideoDir)
    .filter((name) => name.endsWith(".webm"))
    .map((name) => ({ name, size: statSync(join(rawVideoDir, name)).size }))
    .sort((left, right) => right.size - left.size);
  if (videos.length === 0) return;
  renameSync(join(rawVideoDir, videos[0]!.name), join(videoDir, "privagent-demo.webm"));
});
