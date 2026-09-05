import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubLayout } from "./helpers/layout";
import type { Action } from "../src/schemas/screenState";
import type { AuditEntryInput, ToBackground } from "../src/shared/messages";

/**
 * End-to-end coverage of the content-script loop: perceive -> redact -> reason ->
 * validate -> act -> audit, with only the extension messaging boundary mocked.
 *
 * The pipeline this exercises previously existed only as disconnected modules; every
 * unit passed while nothing was wired together. This test fails if the chain breaks.
 */

const sent: ToBackground[] = [];
let nextAction: Action;

vi.mock("webextension-polyfill", () => ({
  default: {
    runtime: {
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(async (message: ToBackground) => {
        sent.push(message);
        if (message.type === "privagent/reason") return { ok: true, value: nextAction };
        return { ok: true, value: { id: "a", timestamp: "t", ...message } };
      }),
    },
  },
}));

const { runTask } = await import("../src/content/content-script");

function action(overrides: Partial<Action> = {}): Action {
  return {
    action: "click",
    target_id: "M1",
    params: {},
    confidence: 0.95,
    risk: "low",
    explanation: "matched the download link",
    reasoning_trace_id: "trace_1",
    ...overrides,
  };
}

function auditStages(): AuditEntryInput[] {
  return sent
    .filter(
      (message): message is Extract<ToBackground, { type: "privagent/audit" }> =>
        message.type === "privagent/audit",
    )
    .map((message) => message.entry);
}

function transmitted() {
  const message = sent.find(
    (entry): entry is Extract<ToBackground, { type: "privagent/reason" }> =>
      entry.type === "privagent/reason",
  );
  return message?.context;
}

describe("the full client loop", () => {
  beforeEach(() => {
    sent.length = 0;
    stubLayout();
    nextAction = action();
    document.body.innerHTML = `
      <p id="note">Call us on 9876543210 or email help@example.com</p>
      <a id="dl" href="/report.pdf">Download report</a>
      <input id="pass" type="password" name="password" />
      <button id="cancel">Cancel</button>`;
    document.querySelector<HTMLInputElement>("#pass")!.value = "Hunter2SuperSecret";
  });

  it("perceives, redacts, reasons and acts, recording every stage", async () => {
    const click = vi.spyOn(document.querySelector<HTMLAnchorElement>("#dl")!, "click");

    const summary = await runTask("task-1", "download report");

    expect(click).toHaveBeenCalled();
    expect(summary.outcome).toBe("executed");
    expect(auditStages().map((entry) => entry.stage)).toEqual([
      "observe",
      "detect_pii",
      "redact",
      "validate",
      "act",
    ]);
  });

  it("transmits no credential value and no raw PII", async () => {
    await runTask("task-2", "download report");
    const payload = JSON.stringify(transmitted());

    expect(payload).not.toContain("Hunter2SuperSecret");
    expect(payload).not.toContain("9876543210");
    expect(payload).not.toContain("help@example.com");
  });

  it("pauses on a medium- or high-risk action and honours a denial", async () => {
    nextAction = action({ action: "navigate", target_id: null, params: { url: "/elsewhere" } });
    const confirm = vi.fn().mockResolvedValue(false);

    const summary = await runTask("task-3", "go elsewhere", { confirm });

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ action: "navigate" }), "high");
    expect(summary.outcome).toBe("denied_by_user");
    expect(auditStages().at(-1)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("denied"),
    });
  });

  it("escalates risk locally even when the server proposes low risk", async () => {
    nextAction = action({
      action: "navigate",
      target_id: null,
      risk: "low",
      params: { url: "/x" },
    });
    const confirm = vi.fn().mockResolvedValue(false);

    await runTask("task-4", "go", { confirm });

    const validate = auditStages().find((entry) => entry.stage === "validate");
    expect(validate?.detail).toContain("effective risk=high");
    expect(validate?.detail).toContain("server proposed low");
  });

  it("reports a stale target instead of clicking the wrong element", async () => {
    const summary = await runTask("task-5", "download report", {
      confirm: async () => true,
    });
    expect(summary.outcome).toBe("executed");

    // The page changes underneath us: the mark the server named is gone.
    document.body.innerHTML = "";
    sent.length = 0;
    const stale = await runTask("task-6", "download report");

    expect(stale.outcome).toBe("failed");
    expect(auditStages().at(-1)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("stale_target"),
    });
  });
});
