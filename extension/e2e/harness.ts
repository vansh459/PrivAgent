import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createSocket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext } from "@playwright/test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Shared setup for the browser suites: which browser to drive, and how to load it. */

/**
 * Playwright's bundled Chromium is preferred (CI installs it); a locally installed Edge
 * or Chrome is used when it is absent.
 */
export function channelOverride(): string | undefined {
  if (process.env.PRIVAGENT_E2E_CHANNEL) return process.env.PRIVAGENT_E2E_CHANNEL;
  if (existsSync(chromium.executablePath())) return undefined;
  for (const [channel, path] of [
    ["msedge", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"],
    ["msedge", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"],
    ["chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe"],
  ] as const) {
    if (existsSync(path)) return channel;
  }
  return undefined;
}

export interface LaunchOptions {
  extensionPath: string;
  /**
   * Profile directory. Pass one when the test needs to identify this browser's own
   * processes - the default temporary directory is not knowable from the outside, and
   * measuring "every Chrome on the machine" measures the user's other windows too.
   */
  userDataDir?: string;
  /**
   * Extra Chromium flags. `--enable-unsafe-swiftshader` is what lets the WebGPU path be
   * exercised on machines and CI runners with no usable GPU - without it the WebGPU probe
   * would simply report "unavailable" everywhere and prove nothing.
   */
  args?: string[];
}

/** Extensions require a full headed Chromium; the headless shell cannot load them. */
export async function launchWithExtension({
  extensionPath,
  args = [],
  userDataDir = "",
}: LaunchOptions): Promise<BrowserContext> {
  const channel = channelOverride();
  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ...(channel ? { channel } : {}),
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      ...args,
    ],
  });
}

/** Resolves the id Chromium assigned to the loaded extension. */
export async function extensionIdOf(context: BrowserContext): Promise<string> {
  const worker =
    context.serviceWorkers().at(-1) ??
    (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  return new URL(worker.url()).host;
}

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createSocket();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The venv interpreter when the project has one, otherwise whatever `python` resolves to. */
function serverPython(): string {
  const venv =
    process.platform === "win32"
      ? join(repoRoot, "server", ".venv", "Scripts", "python.exe")
      : join(repoRoot, "server", ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return process.platform === "win32" ? "python.exe" : "python3";
}

export interface Reasoner {
  url: string;
  stop(): void;
}

/** Starts the real FastAPI reasoner on a free port and waits for it to answer. */
export async function startReasoner(): Promise<Reasoner> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const process_: ChildProcess = spawn(
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
      String(port),
    ],
    { cwd: repoRoot, env: { ...process.env, PYTHONPATH: join(repoRoot, "server") } },
  );

  await waitFor(
    async () => (await fetch(`${url}/health`)).ok,
    30_000,
    "the FastAPI server to become healthy",
  );
  return { url, stop: () => process_.kill() };
}
