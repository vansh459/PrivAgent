import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { extensionIdOf, freePort, launchWithExtension, waitFor } from "./harness";

/**
 * The real thing: a real Chromium-based browser, the real unpacked extension, a real page,
 * the real popup UI, and the real FastAPI server. Everything is asserted against browser
 * state, not mocks.
 *
 * This is the only place the origin-isolation guarantee can actually be demonstrated -
 * that the audit trail lands in the extension's storage and not the visited page's.
 */

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "..", "dist", "chrome");
const repoRoot = resolve(here, "..", "..");

let context: BrowserContext;
let fixtures: Server;
let proxy: Server;
let api: ChildProcess;
let fixtureUrl = "";
let claimsUrl = "";
let proxyUrl = "";
let extensionId = "";

/**
 * Every request body the extension actually sent, captured by a recording proxy.
 *
 * The `/reason` call is made from the service worker, which Playwright's page and context
 * routing does not reliably intercept, so the payload is captured on the wire instead -
 * which is in any case the more honest place to assert "this is what left the browser".
 */
const sentBodies: string[] = [];

/**
 * When set, the proxy answers with this Action instead of forwarding to the reasoner.
 *
 * This stands in for the *server*, so the client's own risk gate and confirmation UI can
 * be exercised in a real browser. The deterministic provider only ever proposes low-risk
 * clicks, which would leave the gate untested.
 */
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
    "Run `npm run build:chrome` before the e2e suite",
  ).toBe(true);

  const fixturePort = await freePort();
  fixtures = createServer((request, response) => {
    const url = request.url ?? "/";
    // The claims fixture needs a real photograph of a face. It is served from the
    // labelled dataset rather than embedded, so the browser suite and the Node
    // evaluation are looking at the same pixels.
    if (url.startsWith("/applicant.png")) {
      const photo = readFileSync(join(repoRoot, "tests", "dataset", "faces", "chawla.png"));
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(photo);
      return;
    }
    const page = url.startsWith("/claims") ? "claims-review.html" : "report-portal.html";
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(readFileSync(join(here, "fixtures", page)));
  });
  await new Promise<void>((done) => fixtures.listen(fixturePort, "127.0.0.1", done));
  fixtureUrl = `http://127.0.0.1:${fixturePort}/portal`;
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
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PYTHONPATH: join(repoRoot, "server"),
        // The suite runs against the deterministic reasoner by default: it answers in
        // milliseconds, so these tests measure the client. Set
        // PRIVAGENT_E2E_REASONER=ollama to run the same tests against the real local
        // model - slower, and the point of doing it is that nothing else about the loop
        // changes when the thing at the other end starts thinking.
        ...(process.env.PRIVAGENT_E2E_REASONER
          ? { PRIVAGENT_REASONER: process.env.PRIVAGENT_E2E_REASONER }
          : {}),
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

  context = await launchWithExtension({ extensionPath });
  extensionId = await extensionIdOf(context);
  expect(extensionId).toBeTruthy();
});

/**
 * Closes every page between tests.
 *
 * Without this the popup windows stack up, and the page under test ends up behind eight
 * of them: an occluded window produces no frames, so `captureVisibleTab` stalls rather
 * than returning, and the vision tests hang instead of failing. Found the hard way - the
 * suite passed test by test and deadlocked when run in order.
 */
test.afterEach(async () => {
  // All but the first: closing the last page of a persistent context closes the browser.
  await Promise.all(
    context
      .pages()
      .slice(1)
      .map((page) => page.close()),
  );
});

test.afterAll(async () => {
  await context?.close();
  api?.kill();
  await new Promise<void>((done) => proxy?.close(() => done()));
  await new Promise<void>((done) => fixtures?.close(() => done()));
});

/**
 * Opens the extension's real popup, in its own window, and points it at this run's server.
 *
 * The popup is driven as a real page rather than by evaluating in the service worker: MV3
 * workers terminate when idle, which invalidates any handle held across a wait, and
 * driving the real UI covers the popup as well as the pipeline behind it.
 *
 * It has to be a separate *window*, not another tab. A browser-action popup leaves the
 * page underneath it visible; a popup opened as a tab does not, and the extension then
 * correctly refuses to screenshot, because the tab it was asked to act on is not the one
 * the camera is pointed at.
 */
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
  // The reasoner URL lives inside a collapsed <details>; open it the way a user would.
  await popup.click("#settings > summary");
  await popup.fill("#server", proxyUrl);
  await popup.click("#save-server");
  await expect(popup.locator("#status")).toHaveText("Reasoner URL saved.");
  return popup;
}

/**
 * Drives the popup, then hands focus back to the page under test.
 *
 * In the product the popup is a browser-action panel and the page stays the visible tab.
 * Playwright can only open it as a tab, so the page has to be brought back to the front -
 * otherwise the extension correctly refuses to screenshot, because the tab it was asked
 * to act on is not the one that would be photographed.
 */
async function runTask(popup: Page, task: string, target?: Page): Promise<void> {
  await popup.fill("#task", task);
  await popup.click("#run");
  await expect(popup.locator("#status")).toHaveAttribute("data-state", "running");
  await target?.bringToFront();
  // Generous: the first task after install also loads ~33 MB of model, runtime and
  // language data. The popup warms those on open, but the suite does not wait for it.
  await expect(popup.locator("#status")).not.toHaveAttribute("data-state", "running", {
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

test("runs the full loop in a real browser and actuates the page", async () => {
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  await expect(page.locator("#result")).toHaveText("not clicked");

  const popup = await openPopup();
  await runTask(popup, "download report");

  // The agent actually clicked the link, rather than merely reporting it.
  await expect(page.locator("#result")).toHaveText("downloaded");

  const rows = await summary(popup);
  expect(rows["Outcome"]).toBe("executed");
  expect(Number(rows["Elements perceived"])).toBeGreaterThan(0);
  // The two role="note"/"status" regions are perceived and redacted, then withheld,
  // so strictly fewer marks are transmitted than were perceived.
  expect(Number(rows["Marks transmitted"])).toBeLessThan(Number(rows["Elements perceived"]));
  expect(Number(rows["Elements redacted"])).toBeGreaterThan(0);
});

test("renders the six-stage audit trace in the popup", async () => {
  const page = await context.newPage();
  await page.goto(fixtureUrl);

  const popup = await openPopup();
  await runTask(popup, "download report");

  expect(await popup.locator("#trace-list .stage").allTextContents()).toEqual([
    "observe",
    "detect_pii",
    "redact",
    "reason",
    "validate",
    "act",
  ]);
});

test("writes the audit trail to the extension origin, not the page's", async () => {
  const page = await context.newPage();
  await page.goto(fixtureUrl);

  const popup = await openPopup();
  await runTask(popup, "download report");

  // The visited page's own storage still holds only what the page itself wrote.
  expect(await page.evaluate(() => ({ ...localStorage }))).toEqual({
    "page-own-key": "page-own-value",
  });
  const pageDatabases = await page.evaluate(async () =>
    (await indexedDB.databases()).map((database) => database.name),
  );
  expect(pageDatabases).not.toContain("privagent");

  // The extension's own origin holds the trail.
  const stages = await popup.evaluate(
    async () =>
      new Promise<string[]>((done, fail) => {
        const request = indexedDB.open("privagent");
        request.onerror = () => fail(request.error);
        request.onsuccess = () => {
          const all = request.result.transaction("audit", "readonly").objectStore("audit").getAll();
          all.onsuccess = () => done(all.result.map((entry: { stage: string }) => entry.stage));
          all.onerror = () => fail(all.error);
        };
      }),
  );
  expect(stages).toEqual(
    expect.arrayContaining(["observe", "detect_pii", "redact", "reason", "validate", "act"]),
  );
});

test("transmits no credential value and no raw PII", async () => {
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  await page.fill("#username", "shivam");
  await page.fill("#password", "Hunter2SuperSecret");

  const before = sentBodies.length;
  const popup = await openPopup();
  await runTask(popup, "download report");

  const payload = sentBodies.slice(before).join("\n");
  expect(payload, "no /reason request was captured").not.toBe("");
  for (const secret of [
    "Hunter2SuperSecret",
    "9876543210",
    "accounts@example.com",
    "1234 5678 9012",
    "4111 1111 1111 1111",
  ]) {
    expect(payload, `payload must not contain ${secret}`).not.toContain(secret);
  }
  expect(payload).toContain("mark_id");
  // The PII-bearing role="note"/"status" regions are not task-relevant, so they are
  // withheld outright rather than transmitted as tokens - the stronger outcome.
  expect(payload).not.toContain("Aadhaar");
});

test("transmits a task-relevant value as a token rather than a number", async () => {
  const page = await context.newPage();
  await page.goto(fixtureUrl);

  const before = sentBodies.length;
  const popup = await openPopup();
  await runTask(popup, "request callback");

  const payload = sentBodies.slice(before).join("\n");
  expect(payload).toContain("Request callback on [PII_PHONE_01]");
  expect(payload).not.toContain("9876543210");
});

test("pauses on a high-risk action and honours a denial", async () => {
  const page = await context.newPage();
  await page.goto(fixtureUrl);

  // The server proposes "low" risk; the client must still score a navigate as high.
  forcedAction = {
    action: "navigate",
    target_id: null,
    params: { url: "#hijacked" },
    confidence: 0.99,
    risk: "low",
    explanation: "Taking you somewhere else entirely.",
    reasoning_trace_id: "trace_e2e",
  };

  try {
    const popup = await openPopup();
    await popup.fill("#task", "download report");
    await popup.click("#run");

    // The prompt is rendered into a closed shadow root on the page, so it is asserted
    // through its host element rather than by querying inside it.
    const host = page.locator("#privagent-confirm-host");
    await expect(host).toBeAttached({ timeout: 30_000 });

    // The prompt is closed to the page, so it cannot be clicked through by selector.
    // Escape is the documented keyboard denial, which is deterministic to drive.
    await page.keyboard.press("Escape");
    await expect(popup.locator("#status")).toContainText("denied_by_user", { timeout: 30_000 });

    expect(page.url()).not.toContain("hijacked");
  } finally {
    forcedAction = undefined;
  }
});

test("renders a complete trace for three separate tasks", async () => {
  const page = await context.newPage();
  await page.goto(fixtureUrl);
  const popup = await openPopup();

  for (const task of ["download report", "request callback", "cancel"]) {
    await runTask(popup, task);
    const stages = await popup.locator("#trace-list .stage").allTextContents();
    expect(stages, `trace for "${task}"`).toEqual([
      "observe",
      "detect_pii",
      "redact",
      "reason",
      "validate",
      "act",
    ]);
  }
});

/**
 * The vision pass, end to end in a real browser.
 *
 * Everything before this point could be asserted against the DOM. These cannot: whether
 * the agent can read text that exists only as canvas pixels, and whether it notices a
 * face in a photograph - and, having noticed, keeps it off the wire.
 */
test("reads text that exists only as canvas pixels, and never transmits the face", async () => {
  const page = await context.newPage();
  await page.goto(claimsUrl);
  await expect(page.locator("#claim-chart")).toBeVisible();

  const before = sentBodies.length;
  const popup = await openPopup();
  await runTask(popup, "check the settlement total", page);

  const rows = await summary(popup);
  expect(Number(rows["Seen by vision"]), "vision contributed no elements").toBeGreaterThan(0);
  expect(Number(rows["Faces detected (never sent)"]), "the applicant photo was not seen").toBe(1);

  const payload = sentBodies.slice(before).join("|");
  // Read off the screen: this string appears in no text node and no attribute.
  expect(payload, "OCR text did not reach the payload").toContain("Settlement total");
  // The face was perceived and then withheld - it is PII in pixels.
  expect(payload).not.toContain("vision_face");
  expect(payload).not.toContain('"role":"face"');
});

test("records the vision pass in the audit trail", async () => {
  const page = await context.newPage();
  await page.goto(claimsUrl);

  const popup = await openPopup();
  await runTask(popup, "approve claim", page);

  const observe = await popup.locator("#trace-list li").first().textContent();
  expect(observe).toContain("vision read");
  expect(observe).toContain("1 face(s)");
  // The face was not only detected but painted out of the screenshot buffer before OCR
  // read from it - the count says how many pixels were destroyed.
  expect(observe).toMatch(/masked [1-9]\d* pixel\(s\)/);
});

test("perceives a DOM-only page without ever taking a screenshot", async () => {
  const page = await context.newPage();
  await page.goto(fixtureUrl);

  const popup = await openPopup();
  await runTask(popup, "download report");

  const rows = await summary(popup);
  expect(rows["Seen by vision"]).toBe("0");
  expect(rows["Faces detected (never sent)"]).toBe("0");
  const observe = await popup.locator("#trace-list li").first().textContent();
  expect(observe).toContain("no visual regions to capture");
});
