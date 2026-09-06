import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestAction } from "../../src/background/reason";
import type { SanitizedContext } from "../../src/schemas/screenState";

/**
 * A real HTTP round-trip against the real FastAPI app, using the real `fetch`.
 *
 * Every other test in this suite mocks its neighbour, which is precisely how a fully
 * disconnected pipeline once sat behind a green test run. This test exists so the
 * client/server contract cannot pass in isolation while failing in reality.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Prefers the server virtualenv when one exists, matching `scripts/server-python.mjs`. */
function serverPython(): string {
  const venv =
    process.platform === "win32"
      ? join(repoRoot, "server", ".venv", "Scripts", "python.exe")
      : join(repoRoot, "server", ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return process.platform === "win32" ? "python.exe" : "python3";
}

let server: ChildProcess | undefined;
let baseUrl = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return true;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(
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

  if (!(await waitForHealth(baseUrl))) {
    throw new Error("The FastAPI server did not become healthy in time");
  }
}, 60_000);

afterAll(() => {
  server?.kill();
});

const context: SanitizedContext = {
  schema_version: "1.0",
  task: "click download",
  elements: [
    { mark_id: "M1", role: "button", text: "Download report", bbox: [0, 0, 100, 30] },
    { mark_id: "M2", role: "link", text: "Help", bbox: [0, 40, 100, 30] },
  ],
};

describe("client -> server reasoning round trip", () => {
  it("returns a schema-valid action over real HTTP", async () => {
    const action = await requestAction(context, { serverUrl: baseUrl });

    expect(action.action).toBe("click");
    expect(action.target_id).toBe("M1");
    expect(action.reasoning_trace_id).toMatch(/^trace_/);
  });

  it("is rejected by the server when the payload carries an unexpected field", async () => {
    const leaky = { ...context, screenshot: "data:image/png;base64,AAA" };
    const response = await fetch(`${baseUrl}/reason`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(leaky),
    });

    expect(response.status).toBe(422);
  });

  it("reports the active reasoning provider", async () => {
    const health = await (await fetch(`${baseUrl}/health`)).json();

    expect(health).toMatchObject({ status: "ok", provider: "deterministic" });
  });
});
