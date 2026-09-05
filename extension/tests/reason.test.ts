import { describe, expect, it, vi } from "vitest";
import { requestAction } from "../src/background/reason";
import { PrivAgentError } from "../src/shared/errors";
import type { SanitizedContext } from "../src/schemas/screenState";

const context: SanitizedContext = {
  schema_version: "1.0",
  task: "click download",
  elements: [{ mark_id: "M1", role: "button", text: "Download", bbox: [0, 0, 10, 10] }],
};

const validAction = {
  action: "click",
  target_id: "M1",
  params: {},
  confidence: 0.9,
  risk: "low",
  explanation: "matched",
  reasoning_trace_id: "trace_1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("requestAction", () => {
  it("posts the sanitized context and returns a validated action", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(validAction));

    const action = await requestAction(context, {
      serverUrl: "http://127.0.0.1:8000/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(action.target_id).toBe("M1");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8000/reason");
    expect(JSON.parse(init.body)).toEqual(context);
  });

  it("refuses to transmit a context that fails the sanitized schema", async () => {
    const fetchImpl = vi.fn();
    const leaky = { ...context, raw_screenshot: "data:image/png;base64,AAA" };

    await expect(
      requestAction(leaky as SanitizedContext, {
        serverUrl: "http://127.0.0.1:8000",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports an unreachable server rather than hanging", async () => {
    await expect(
      requestAction(context, {
        serverUrl: "http://127.0.0.1:1",
        fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "server_unreachable" });
  });

  it("reports a rejected request", async () => {
    await expect(
      requestAction(context, {
        serverUrl: "http://127.0.0.1:8000",
        fetchImpl: vi
          .fn()
          .mockResolvedValue(jsonResponse({ detail: "bad" }, 422)) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "server_rejected" });
  });

  it("never forwards a malformed action to the caller", async () => {
    await expect(
      requestAction(context, {
        serverUrl: "http://127.0.0.1:8000",
        fetchImpl: vi
          .fn()
          .mockResolvedValue(jsonResponse({ action: "click" })) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(PrivAgentError);
  });
});
