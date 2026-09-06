import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { extensionIdOf, freePort, launchWithExtension, waitFor } from "./harness";

/**
 * Build Spec Phase 6.3: all four action types, on five different pages, with no misfires.
 *
 * The executor already had unit tests. What those cannot establish is the part that
 * matters in a browser - that a `target_id` chosen by a reasoner, from marks produced by a
 * real perception pass over a real layout, resolves back to the one live element it was
 * meant to name. So every assertion here is made against the page's own state: the handler
 * the page installed fired, the input the page owns holds the value, the window actually
 * scrolled, the URL actually changed. The executor's return value is not consulted once.
 *
 * "No misfires" is asserted rather than assumed. Each page records every click and input
 * event it receives, and after an action that ledger must contain exactly one entry, on
 * exactly the intended element. A click executor that fired twice, or fired on a
 * neighbouring anchor, passes an outcome check and fails this one.
 *
 * The action under test is forced from the payload the extension actually sent, rather
 * than left to the reasoner. This is a test of the executor, not of the model: the
 * deterministic provider only ever proposes low-risk clicks, which would leave `type`,
 * `scroll` and `navigate` - and the confirmation gate guarding two of them - unexercised in
 * a browser, which is precisely the gap Phase 6.3 was left open on.
 */

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "..", "dist", "chrome");
const repoRoot = resolve(here, "..", "..");

let context: BrowserContext;
let fixtures: Server;
let proxy: Server;
let api: ChildProcess;
let baseUrl = "";
let proxyUrl = "";
let extensionId = "";

interface SentMark {
  mark_id: string;
  role: string;
  text: string;
}

interface SentContext {
  task: string;
  elements: SentMark[];
}

/** Chooses the action to return, from the sanitized context the extension just sent. */
type Responder = (sent: SentContext) => Record<string, unknown> | undefined;

let responder: Responder | undefined;

/** A page under test, described by what a reader can check on it afterwards. */
interface PagePlan {
  path: string;
  title: string;
  /** Text of the element to click, as the DOM walker will report it. */
  clickText: string;
  clickTargetId: string;
  resultBefore: string;
  resultAfter: string;
  /** Label of the text field to type into, and the element that must hold the value. */
  fieldLabel: string;
  fieldSelector: string;
  fieldTargetId: string;
  /** A same-document destination, so the content script survives to be asserted against. */
  hash: string;
}

const PAGES: readonly PagePlan[] = [
  {
    path: "/portal",
    title: "Expenditure Portal",
    clickText: "Download report",
    clickTargetId: "download",
    resultBefore: "not clicked",
    resultAfter: "downloaded",
    fieldLabel: "Username",
    fieldSelector: "#username",
    fieldTargetId: "username",
    hash: "#audit-log",
  },
  {
    path: "/claims",
    title: "Claims Review",
    clickText: "Approve claim",
    clickTargetId: "approve",
    resultBefore: "not decided",
    resultAfter: "approved",
    fieldLabel: "Adjuster note",
    fieldSelector: "#adjuster-note",
    fieldTargetId: "adjuster-note",
    hash: "#adjuster",
  },
  {
    path: "/dashboard",
    title: "Operations Dashboard",
    clickText: "Refresh metrics",
    clickTargetId: "refresh",
    resultBefore: "not refreshed",
    resultAfter: "refreshed",
    fieldLabel: "Filter metrics",
    fieldSelector: "#metric-filter",
    fieldTargetId: "metric-filter",
    hash: "#archive-view",
  },
  {
    path: "/application",
    title: "Benefit Application",
    clickText: "Continue to step 2",
    clickTargetId: "continue",
    resultBefore: "step 1",
    resultAfter: "step 2",
    fieldLabel: "Full name",
    fieldSelector: "#full-name",
    fieldTargetId: "full-name",
    hash: "#terms-read",
  },
  {
    path: "/records",
    title: "Records Index",
    clickText: "Open handbook",
    clickTargetId: "handbook",
    resultBefore: "nothing opened",
    resultAfter: "handbook opened",
    fieldLabel: "Filter documents",
    fieldSelector: "#filter",
    fieldTargetId: "filter",
    hash: "#handbook-view",
  },
];

const FILES: Record<string, string> = {
  "/portal": "report-portal.html",
  "/claims": "claims-review.html",
  "/dashboard": "ops-dashboard.html",
  "/application": "benefit-application.html",
  "/records": "records-index.html",
};

/**
 * Records every click and input the page receives, whoever caused it.
 *
 * Installed at document start in the page's own world, so it sees the events the executor
 * dispatches exactly as the page's own handlers do. This is what turns "the right thing
 * happened" into "only the right thing happened".
 */
const LEDGER = `
  window.__privagentLedger = [];
  addEventListener(
    "click",
    (event) => window.__privagentLedger.push({ kind: "click", id: event.target.id }),
    true,
  );
  addEventListener(
    "input",
    (event) =>
      window.__privagentLedger.push({
        kind: "input",
        id: event.target.id,
        value: event.target.value,
      }),
    true,
  );
`;

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
    const path = (request.url ?? "/").split("?")[0]!.split("#")[0]!;
    if (path === "/applicant.png") {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(readFileSync(join(repoRoot, "tests", "dataset", "faces", "chawla.png")));
      return;
    }
    // The destination for the one cross-document navigation, deliberately trivial: what is
    // asserted there is that the browser went somewhere else, not what it found.
    if (path === "/landing") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<!doctype html><title>Landing</title><h1 id="landed">landed</h1>');
      return;
    }
    const file = FILES[path] ?? "report-portal.html";
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(readFileSync(join(here, "fixtures", file)));
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
      if (request.url?.includes("/reason") && responder) {
        const forced = responder(JSON.parse(body) as SentContext);
        if (forced) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(forced));
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
  await context.addInitScript(LEDGER);
  extensionId = await extensionIdOf(context);
  expect(extensionId).toBeTruthy();
});

/**
 * Closes every page between tests. Popup windows otherwise stack up in front of the page
 * under test, and an occluded window produces no frames, so `captureVisibleTab` stalls.
 */
test.afterEach(async () => {
  responder = undefined;
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

/** Opens the real popup in its own window, pointed at the forcing proxy. */
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

/**
 * Runs one task and waits for it to settle, approving the confirmation gate if asked.
 *
 * `type` scores medium risk locally and `navigate` scores high, so two of the four action
 * types cannot reach the executor at all without passing the gate. Approval is Ctrl+Enter,
 * the deliberately awkward keystroke - a bare Enter does nothing, by design.
 */
async function runTask(
  popup: Page,
  page: Page,
  task: string,
  options: { approve?: boolean } = {},
): Promise<void> {
  await popup.fill("#task", task);
  await popup.click("#run");
  await expect(popup.locator("#status")).toHaveAttribute("data-state", "running");
  await page.bringToFront();

  if (options.approve) {
    await expect(page.locator("#privagent-confirm-host")).toBeAttached({ timeout: 120_000 });
    await page.keyboard.press("Control+Enter");
  }

  await expect(popup.locator("#status")).not.toHaveAttribute("data-state", "running", {
    timeout: 120_000,
  });
  await expect(popup.locator("#status")).toHaveAttribute("data-state", "done");
}

interface LedgerEntry {
  kind: string;
  id: string;
  value?: string;
}

async function ledger(page: Page): Promise<LedgerEntry[]> {
  return page.evaluate(
    () => (globalThis as unknown as { __privagentLedger: LedgerEntry[] }).__privagentLedger,
  );
}

async function clearLedger(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as { __privagentLedger: unknown[] }).__privagentLedger.length = 0;
  });
}

/** Resolves a mark id from the payload the extension actually sent, by its visible text. */
function markFor(sent: SentContext, text: string): string {
  const mark = sent.elements.find((element) => element.text === text);
  if (!mark) {
    const seen = sent.elements.map((element) => element.text).join(" | ");
    throw new Error(`no transmitted mark carried the text "${text}"; marks were: ${seen}`);
  }
  return mark.mark_id;
}

function action(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    action: "none",
    target_id: null,
    params: {},
    confidence: 0.9,
    risk: "low",
    explanation: "Forced by the Phase 6.3 executor suite.",
    reasoning_trace_id: "trace_executor_e2e",
    ...fields,
  };
}

for (const plan of PAGES) {
  test(`executes all four action types on ${plan.title}`, async () => {
    // Four full perception passes on one page; the first of the run is also cold.
    test.setTimeout(300_000);

    const page = await context.newPage();
    await page.goto(`${baseUrl}${plan.path}`);
    await expect(page).toHaveTitle(plan.title);
    await expect(page.locator("#result")).toHaveText(plan.resultBefore);

    const popup = await openPopup();

    // --- click ---------------------------------------------------------------------
    responder = (sent) => action({ action: "click", target_id: markFor(sent, plan.clickText) });
    await clearLedger(page);
    await runTask(popup, page, `click ${plan.clickText.toLowerCase()}`);

    await expect(page.locator("#result")).toHaveText(plan.resultAfter);
    expect(await ledger(page), "a click must actuate exactly one element").toEqual([
      { kind: "click", id: plan.clickTargetId },
    ]);

    // --- type ----------------------------------------------------------------------
    const typed = `privagent-${plan.path.slice(1)}`;
    responder = (sent) =>
      action({
        action: "type",
        target_id: markFor(sent, plan.fieldLabel),
        params: { text: typed },
      });
    await clearLedger(page);
    await runTask(popup, page, `fill in ${plan.fieldLabel.toLowerCase()}`, { approve: true });

    await expect(page.locator(plan.fieldSelector)).toHaveValue(typed);
    expect(await ledger(page), "a type must touch exactly one field").toEqual([
      { kind: "input", id: plan.fieldTargetId, value: typed },
    ]);

    // --- scroll --------------------------------------------------------------------
    await page.evaluate(() => window.scrollTo(0, 0));
    // `params` is a string map on the wire, and the executor coerces - so the value is
    // quoted here exactly as a model constrained by the schema would emit it.
    responder = () => action({ action: "scroll", params: { top: "600" } });
    await clearLedger(page);
    await runTask(popup, page, "scroll down the page");

    // `scrollBy` is smooth, so the final position arrives after the task reports done.
    await page.waitForFunction(() => window.scrollY > 400, undefined, { timeout: 15_000 });
    expect(await ledger(page), "scrolling must not click or type anything").toEqual([]);

    // --- navigate ------------------------------------------------------------------
    await page.evaluate(() => window.scrollTo(0, 0));
    responder = () => action({ action: "navigate", params: { url: plan.hash } });
    await clearLedger(page);
    await runTask(popup, page, "go to the next section", { approve: true });

    await page.waitForFunction((hash) => window.location.hash === hash, plan.hash, {
      timeout: 15_000,
    });
    expect(await ledger(page), "navigating must not click or type anything").toEqual([]);

    // Nothing else on the page moved while four actions were executed against it.
    await expect(page.locator("#result")).toHaveText(plan.resultAfter);
  });
}

/**
 * The same-document navigations above keep the content script alive so the ledger can be
 * read afterwards. This one leaves the document entirely, which is what a user will
 * actually hit, and asserts the only thing that survives it: the browser is somewhere else.
 */
test("navigates across documents", async () => {
  test.setTimeout(120_000);

  const page = await context.newPage();
  await page.goto(`${baseUrl}/portal`);
  const popup = await openPopup();

  responder = () => action({ action: "navigate", params: { url: `${baseUrl}/landing` } });
  await popup.fill("#task", "open the landing page");
  await popup.click("#run");
  await page.bringToFront();
  await expect(page.locator("#privagent-confirm-host")).toBeAttached({ timeout: 120_000 });
  await page.keyboard.press("Control+Enter");

  await page.waitForURL(`${baseUrl}/landing`, { timeout: 30_000 });
  await expect(page.locator("#landed")).toHaveText("landed");
});
