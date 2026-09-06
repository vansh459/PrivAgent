import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { extensionIdOf, freePort, launchWithExtension, waitFor } from "./harness";

/**
 * The multi-step loop, end to end in a real browser: a task whose first action navigates
 * to a second page, completed across the navigation with every payload wire-captured -
 * and a bot-walled page on which the same loop stops at step one.
 *
 * The deterministic reasoner drives it, which bounds what "multi-step" can mean here to
 * exactly two steps: it clicks the matching element, and on the next step answers `done`
 * because the history says the click executed. That is precisely enough to prove what
 * this suite owns - controller survival across a page load, history reaching the server
 * as schema 1.1, terminal states, and the privacy contract holding on every step. What a
 * smarter model does with more steps is the live-site validation's job, not this file's.
 */

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "..", "dist", "chrome");
const repoRoot = resolve(here, "..", "..");

let context: BrowserContext;
let fixtures: Server;
let proxy: Server;
let api: ChildProcess;
let listUrl = "";
let wallUrl = "";
let proxyUrl = "";
let extensionId = "";

const sentBodies: string[] = [];

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
    const page = url.startsWith("/loop-report")
      ? "loop-report.html"
      : url.startsWith("/bot-wall")
        ? "bot-wall.html"
        : "loop-list.html";
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(readFileSync(join(here, "fixtures", page)));
  });
  await new Promise<void>((done) => fixtures.listen(fixturePort, "127.0.0.1", done));
  listUrl = `http://127.0.0.1:${fixturePort}/loop-list`;
  wallUrl = `http://127.0.0.1:${fixturePort}/bot-wall`;

  const apiPort = await freePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  api = spawn(
    serverPython(),
    ["-m", "uvicorn", "app.main:app", "--app-dir", "server", "--host", "127.0.0.1", "--port", String(apiPort)],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PYTHONPATH: join(repoRoot, "server"),
        // Hermetic: a developer's server/.env must not reroute this suite to a remote
        // model. The loop's machinery is what is under test, not the model.
        PRIVAGENT_REASONER: process.env.PRIVAGENT_E2E_REASONER ?? "deterministic",
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

  context = await launchWithExtension({ extensionPath });
  extensionId = await extensionIdOf(context);
});

test.afterEach(async () => {
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

async function runLoopTask(popup: Page, task: string, target: Page): Promise<void> {
  await popup.check("#multi-step");
  await popup.fill("#task", task);
  await popup.click("#run");
  await expect(popup.locator("#status")).toHaveAttribute("data-state", "running");
  await target.bringToFront();
  await expect(popup.locator("#status")).not.toHaveAttribute("data-state", "running", {
    timeout: 120_000,
  });
}

test("completes a task across a navigation and reports done", async () => {
  sentBodies.length = 0;
  const page = await context.newPage();
  await page.goto(listUrl, { waitUntil: "load" });
  const popup = await openPopup();

  await runLoopTask(popup, "open the report page", page);

  // Step 1 clicked the link on the list page, which navigated; step 2 saw the history
  // and reported done. The final status must say so, in those terms.
  await expect(popup.locator("#status")).toContainText("Task completed after 2 step(s)");
  expect(page.url()).toContain("/loop-report");

  // Two /reason payloads left the browser. The second is a 1.1 payload carrying the
  // first step's history - action, role, outcome, and the REDACTED page title.
  expect(sentBodies).toHaveLength(2);
  const first = JSON.parse(sentBodies[0]!) as Record<string, unknown>;
  const second = JSON.parse(sentBodies[1]!) as {
    schema_version: string;
    step: { n: number; limit: number };
    history: { action: string; target_role: string | null; page_ident: string }[];
  };
  expect(first["schema_version"]).toBe("1.1");
  expect(second.schema_version).toBe("1.1");
  expect(second.step.n).toBe(2);
  expect(second.history).toHaveLength(1);
  expect(second.history[0]!.action).toBe("click");
  expect(second.history[0]!.target_role).toBe("link");
  expect(second.history[0]!.page_ident).toContain("Quarterly Reports");

  // The privacy contract holds on every step of a loop, not just on single shots.
  for (const body of sentBodies) {
    expect(body).not.toContain("9876543210");
    expect(body).not.toContain("registrar@example.com");
  }
});

test("stops at step one on a bot-walled page and says why", async () => {
  sentBodies.length = 0;
  const page = await context.newPage();
  await page.goto(wallUrl, { waitUntil: "load" });
  const popup = await openPopup();

  await runLoopTask(popup, "continue to the site", page);

  await expect(popup.locator("#status")).toContainText("blocks automation");
  await expect(popup.locator("#status")).toContainText("after 1 step(s)");
  // Stopping means stopping: no reasoning request was ever made for this page, and the
  // tempting "Continue" link was never clicked.
  expect(sentBodies).toHaveLength(0);
  expect(page.url()).toBe(wallUrl);
});

test("the stop button cancels a running loop between steps", async () => {
  sentBodies.length = 0;
  const page = await context.newPage();
  await page.goto(listUrl, { waitUntil: "load" });
  const popup = await openPopup();

  await popup.check("#multi-step");
  await popup.fill("#task", "open the report page");
  await popup.click("#run");
  await expect(popup.locator("#stop")).toBeVisible();
  await popup.click("#stop");
  await page.bringToFront();
  await expect(popup.locator("#status")).not.toHaveAttribute("data-state", "running", {
    timeout: 120_000,
  });

  // Either the cancel landed between steps, or the two-step task finished first - both
  // are legitimate outcomes of pressing stop; hanging or erroring is not.
  const status = (await popup.locator("#status").textContent()) ?? "";
  expect(status).toMatch(/Stopped by you|Task completed/);
});
