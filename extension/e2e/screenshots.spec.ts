import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { extensionIdOf, freePort, launchWithExtension, waitFor } from "./harness";

/**
 * Captures every UI surface, in both colour schemes, for the before/after review.
 *
 * Skipped unless `PRIVAGENT_UI_SHOTS` names a phase, because this suite exists to produce
 * images rather than to catch regressions and there is no reason to pay for it on every
 * run. Shots land in `docs/ui/<phase>/`:
 *
 *     PRIVAGENT_UI_SHOTS=before npx playwright test e2e/screenshots.spec.ts
 *     ... redesign ...
 *     PRIVAGENT_UI_SHOTS=after  npx playwright test e2e/screenshots.spec.ts
 *
 * The four surfaces are the whole of this product's interface: the popup before a task and
 * after one, the diagnostics page, and the confirmation prompt as it appears on somebody
 * else's page. The offscreen document is deliberately absent - it is never rendered.
 */

const phase = process.env.PRIVAGENT_UI_SHOTS;

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "..", "dist", "chrome");
const repoRoot = resolve(here, "..", "..");
const outputDir = join(repoRoot, "docs", "ui", phase ?? "unset");

let context: BrowserContext;
let fixtures: Server;
let proxy: Server;
let api: ChildProcess;
let portalUrl = "";
let proxyUrl = "";
let extensionId = "";
let forcedAction: Record<string, unknown> | undefined;

function serverPython(): string {
  const venv =
    process.platform === "win32"
      ? join(repoRoot, "server", ".venv", "Scripts", "python.exe")
      : join(repoRoot, "server", ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return process.platform === "win32" ? "python.exe" : "python3";
}

test.skip(!phase, "set PRIVAGENT_UI_SHOTS=before|after to capture the UI");

test.beforeAll(async () => {
  expect(
    existsSync(join(extensionPath, "manifest.json")),
    "Run `npm run build:chrome` before capturing screenshots",
  ).toBe(true);
  mkdirSync(outputDir, { recursive: true });

  const fixturePort = await freePort();
  fixtures = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(readFileSync(join(here, "fixtures", "report-portal.html")));
  });
  await new Promise<void>((done) => fixtures.listen(fixturePort, "127.0.0.1", done));
  portalUrl = `http://127.0.0.1:${fixturePort}/portal`;

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
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PYTHONPATH: join(repoRoot, "server"),
        // Hermetic: a developer's server/.env must not silently reroute this suite
        // through a remote model - measurements are deterministic unless opted in.
        PRIVAGENT_REASONER: process.env.PRIVAGENT_REASONER ?? "deterministic",
      },
    },
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
      // Standing in for the server so the risk gate can be photographed: the deterministic
      // provider only ever proposes low-risk clicks, which never raise a prompt.
      if (request.url?.includes("/reason") && forcedAction) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(forcedAction));
        return;
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

  context = await launchWithExtension({ extensionPath });
  extensionId = await extensionIdOf(context);
});

test.afterAll(async () => {
  await context?.close();
  api?.kill();
  await new Promise<void>((done) => proxy?.close(() => done()));
  await new Promise<void>((done) => fixtures?.close(() => done()));
});

async function openPopup(scheme: "light" | "dark"): Promise<Page> {
  const opener = await context.newPage();
  const popupUrl = `chrome-extension://${extensionId}/src/ui/popup.html`;
  await opener.goto(popupUrl);
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    opener.evaluate(
      (url) =>
        (
          globalThis as unknown as { chrome: { windows: { create(options: unknown): void } } }
        ).chrome.windows.create({ url, type: "popup", width: 460, height: 820 }),
      popupUrl,
    ),
  ]);
  await opener.close();
  await popup.emulateMedia({ colorScheme: scheme });
  await popup.waitForLoadState();
  await popup.click("#settings > summary");
  await popup.fill("#server", proxyUrl);
  await popup.click("#save-server");
  await expect(popup.locator("#status")).toHaveText("Reasoner URL saved.");
  // Collapsed again so the idle shot is the popup as a user first meets it.
  await popup.click("#settings > summary");
  return popup;
}

/**
 * Shoots the document itself rather than the viewport.
 *
 * The popup is a fixed-width panel inside whatever window Playwright gives it, so a
 * viewport screenshot is mostly empty desktop. Framing the body keeps the before and after
 * comparable at the size the thing is actually seen.
 */
async function shoot(page: Page, name: string): Promise<void> {
  await page.locator("body").screenshot({ path: join(outputDir, `${name}.png`) });
}

for (const scheme of ["light", "dark"] as const) {
  test(`captures every surface in ${scheme} mode`, async () => {
    test.setTimeout(10 * 60_000);

    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(portalUrl);

    // --- the popup, idle ------------------------------------------------------------
    const popup = await openPopup(scheme);
    await popup.fill("#task", "download report");
    await shoot(popup, `popup-idle-${scheme}`);

    // --- the popup, after a task: summary and audit trail populated ------------------
    await popup.click("#run");
    await page.bringToFront();
    await expect(popup.locator("#status")).toHaveAttribute("data-state", "done", {
      timeout: 120_000,
    });
    await shoot(popup, `popup-task-${scheme}`);

    // --- the confirmation prompt, on somebody else's page ---------------------------
    forcedAction = {
      action: "navigate",
      target_id: null,
      params: { url: "#elsewhere" },
      confidence: 0.99,
      risk: "low",
      explanation: "Taking you somewhere else entirely.",
      reasoning_trace_id: "trace_shots",
    };
    try {
      await popup.fill("#task", "download report");
      await popup.click("#run");
      await page.bringToFront();
      await expect(page.locator("#privagent-confirm-host")).toBeAttached({ timeout: 60_000 });
      // The host element, not the viewport: the card is a 320px panel in a corner, and a
      // full-page shot of somebody else's page is not a picture of it.
      await page
        .locator("#privagent-confirm-host")
        .screenshot({ path: join(outputDir, `confirm-${scheme}.png`) });
      await page.keyboard.press("Escape");
      await expect(popup.locator("#status")).toContainText("denied_by_user", { timeout: 60_000 });
    } finally {
      forcedAction = undefined;
    }
    await popup.close();

    // --- the diagnostics page, with its probe run -----------------------------------
    const diagnostics = await context.newPage();
    await diagnostics.emulateMedia({ colorScheme: scheme });
    await diagnostics.goto(`chrome-extension://${extensionId}/src/ui/diagnostics.html`);
    await diagnostics.click("#run-probe");
    await expect(diagnostics.locator("#probe-status")).toHaveAttribute("data-state", "done", {
      timeout: 180_000,
    });
    await shoot(diagnostics, `diagnostics-${scheme}`);
    await diagnostics.close();
    await page.close();
  });
}
