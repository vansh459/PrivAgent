import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { extensionIdOf, freePort, launchWithExtension, waitFor } from "./harness";

/**
 * Live-site validation: the real extension, the real Foundry Claude chain, real public
 * websites. Asserts only what a live site can honestly guarantee: the loop reaches a
 * terminal state and never errors out. Status, steps, final URL and screenshots land in
 * test-results/ as demo evidence.
 *
 * OPT-IN: set PRIVAGENT_LIVE=1 to run. Skipped otherwise - these tests reach the public
 * internet and depend on third-party sites, so they must never gate the hermetic suites.
 * Verified 2026-09-08: wikipedia "search for ISRO" -> ISRO article, done in 2 steps
 * (31.8s); amazon.in "search for usb microphone" -> results page, done in 2 steps (37s).
 */

test.skip(!process.env.PRIVAGENT_LIVE, "live-site tests run only with PRIVAGENT_LIVE=1");

const here = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(here, "..", "dist", "chrome");
const repoRoot = resolve(here, "..", "..");

let context: BrowserContext;
let api: ChildProcess;
let apiUrl = "";
let extensionId = "";

test.beforeAll(async () => {
  const apiPort = await freePort();
  apiUrl = `http://127.0.0.1:${apiPort}`;
  const venv = join(repoRoot, "server", ".venv", "Scripts", "python.exe");
  api = spawn(
    existsSync(venv) ? venv : "python.exe",
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
        PRIVAGENT_REASONER: "foundry", // the demo brain; keys come from server/.env
      },
    },
  );
  await waitFor(async () => (await fetch(`${apiUrl}/health`)).ok, 30_000, "api");
  context = await launchWithExtension({ extensionPath });
  extensionId = await extensionIdOf(context);
});

test.afterAll(async () => {
  await context?.close();
  api?.kill();
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
  await popup.fill("#server", apiUrl);
  await popup.click("#save-server");
  await expect(popup.locator("#status")).toHaveText("Reasoner URL saved.");
  return popup;
}

async function runLive(name: string, url: string, task: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(2_000);
  const popup = await openPopup();

  await popup.check("#multi-step");
  await popup.fill("#task", task);
  await popup.click("#run");
  await page.bringToFront();
  await expect(popup.locator("#status")).not.toHaveAttribute("data-state", "running", {
    timeout: 240_000,
  });

  const status = (await popup.locator("#status").textContent()) ?? "";
  const state = await popup.locator("#status").getAttribute("data-state");
  const trace = await popup.locator("#trace-list li").allTextContents();
  console.log(`\n===== ${name} =====`);
  console.log(`task:   ${task}`);
  console.log(`status: [${state}] ${status}`);
  console.log(`url:    ${page.url().slice(0, 120)}`);
  for (const line of trace) console.log(`  ${line.slice(0, 160)}`);
  await page.screenshot({ path: `../test-results/live-${name}-page.png` }).catch(() => undefined);
  await popup.screenshot({ path: `../test-results/live-${name}-popup.png` }).catch(() => undefined);
  await popup.close();
  await page.close();

  // A live site may bot-wall us (a legitimate stop) - but erroring out is a failure.
  expect(state).not.toBe("error");
}

test("wikipedia: search and open an article", async () => {
  test.setTimeout(300_000);
  await runLive("wikipedia", "https://en.wikipedia.org/wiki/Main_Page", "search for ISRO");
});

test("amazon: search for a product", async () => {
  test.setTimeout(300_000);
  await runLive("amazon", "https://www.amazon.in/", "search for usb microphone");
});
