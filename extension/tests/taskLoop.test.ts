import { describe, expect, it, vi } from "vitest";

vi.mock("webextension-polyfill", () => ({
  default: { runtime: {}, tabs: { sendMessage: vi.fn(), query: vi.fn() } },
}));
// The audit store needs IndexedDB; these tests inject seams and only need it to no-op.
vi.mock("../src/background/audit", () => ({ appendAudit: vi.fn().mockResolvedValue({}) }));

import {
  cancelTask,
  loopResult,
  runTaskLoop,
  startTaskLoop,
  STEP_BUDGET,
} from "../src/background/taskLoop";
import type { Reply, StepReport, ToContent } from "../src/shared/messages";

/**
 * The loop state machine, driven with scripted steps: every terminal state must be
 * reachable, the budget must hold, history must accumulate and be passed forward, and a
 * bot-block must end the loop on the spot - no retry, no second look.
 */

function report(partial: Partial<StepReport>): StepReport {
  return {
    state: "executed",
    actionType: "click",
    targetRole: "link",
    outcome: "executed click",
    pageIdent: "Fixture Page",
    summary: {
      taskId: "t",
      task: "task",
      observed: 1,
      perceivedByVision: 0,
      facesDetected: 0,
      transmitted: 1,
      redactedElements: 0,
      withheldForReview: 0,
      action: null,
      outcome: "executed",
    },
    ...partial,
  };
}

/** Scripted transport: pops one report per step and records every message sent. */
function scripted(...reports: StepReport[]) {
  const sent: Extract<ToContent, { type: "privagent/loop-step" }>[] = [];
  const sendStep = async (_tabId: number, message: ToContent): Promise<Reply<StepReport>> => {
    sent.push(message as Extract<ToContent, { type: "privagent/loop-step" }>);
    const next = reports.shift();
    if (!next) return { ok: false, error: { code: "execution_failed", message: "script ran dry" } };
    return { ok: true, value: next };
  };
  return { sendStep, sent, resolveTabId: async () => 1 };
}

describe("multi-step task loop", () => {
  it("chains steps and finishes when the model says done", async () => {
    const seams = scripted(
      report({ state: "executed" }),
      report({ state: "executed", actionType: "type", targetRole: "text_field" }),
      report({ state: "done", actionType: "done", outcome: "task reported done" }),
    );
    const result = await runTaskLoop("t1", "order the item", seams);

    expect(result.status).toBe("done");
    expect(result.steps).toBe(3);
    // Step 3 must have seen the two prior steps, in order, with their roles.
    expect(seams.sent[2]!.history.map((entry) => entry.action)).toEqual(["click", "type"]);
    expect(seams.sent[2]!.step).toEqual({ n: 3, limit: STEP_BUDGET });
  });

  it("stops immediately and permanently on a bot challenge", async () => {
    const seams = scripted(
      report({ state: "blocked", actionType: "blocked", blockedReason: "bot_detection" }),
      report({ state: "executed" }), // must never be requested
    );
    const result = await runTaskLoop("t2", "buy socks", seams);

    expect(result.status).toBe("blocked");
    expect(result.detail).toBe("bot_detection");
    expect(seams.sent).toHaveLength(1);
  });

  it("treats a user denial as declined, not as an error", async () => {
    const seams = scripted(report({ state: "declined", outcome: "denied by user" }));
    const result = await runTaskLoop("t3", "submit the form", seams);

    expect(result.status).toBe("declined");
    expect(seams.sent).toHaveLength(1);
  });

  it("exhausts the budget rather than looping forever", async () => {
    const endless = Array.from({ length: 40 }, () => report({ state: "executed" }));
    const seams = scripted(...endless);
    const result = await runTaskLoop("t4", "keep clicking", { ...seams, stepBudget: 5 });

    expect(result.status).toBe("budget_exhausted");
    expect(result.steps).toBe(5);
    expect(seams.sent).toHaveLength(5);
  });

  it("declares no_progress after consecutive none answers", async () => {
    const seams = scripted(
      report({ state: "none", actionType: "none", outcome: "no action proposed" }),
      report({ state: "none", actionType: "none", outcome: "no action proposed" }),
      report({ state: "executed" }), // must never be requested
    );
    const result = await runTaskLoop("t5", "do the impossible", seams);

    expect(result.status).toBe("no_progress");
    expect(seams.sent).toHaveLength(2);
  });

  it("an executed step resets the stall counter", async () => {
    const seams = scripted(
      report({ state: "none", actionType: "none" }),
      report({ state: "executed" }),
      report({ state: "none", actionType: "none" }),
      report({ state: "done", actionType: "done" }),
    );
    const result = await runTaskLoop("t6", "browse around", seams);

    expect(result.status).toBe("done");
    expect(result.steps).toBe(4);
  });

  it("honours cancellation between steps", async () => {
    let steps = 0;
    const sendStep = async (): Promise<Reply<StepReport>> => {
      steps += 1;
      cancelTask("t7"); // user presses stop while step 1 runs
      return { ok: true, value: report({ state: "executed" }) };
    };
    const result = await runTaskLoop("t7", "long task", {
      sendStep,
      resolveTabId: async () => 1,
    });

    expect(result.status).toBe("cancelled");
    expect(steps).toBe(1);
  });

  it("fails cleanly when a step errors and when no tab exists", async () => {
    const erroring = async (): Promise<Reply<StepReport>> => ({
      ok: false,
      error: { code: "execution_failed", message: "boom" },
    });
    const failed = await runTaskLoop("t8", "task", {
      sendStep: erroring,
      resolveTabId: async () => 1,
    });
    expect(failed.status).toBe("failed");
    expect(failed.detail).toContain("boom");

    const noTab = await runTaskLoop("t9", "task", {
      sendStep: erroring,
      resolveTabId: async () => {
        throw new Error("No web page tab");
      },
    });
    expect(noTab.status).toBe("failed");
  });

  it("startTaskLoop returns at once and the result becomes pollable", async () => {
    const seams = scripted(report({ state: "done", actionType: "done", outcome: "finished" }));

    startTaskLoop("t11", "quick task", seams);
    // The whole point of the fire-and-poll split: nothing is known synchronously.
    expect(loopResult("t11")).toBeNull();

    await vi.waitFor(() => expect(loopResult("t11")).not.toBeNull());
    expect(loopResult("t11")!.status).toBe("done");
    // Polling is repeatable - the popup may ask again after re-opening.
    expect(loopResult("t11")!.detail).toBe("finished");
  });

  it("startTaskLoop turns an escaped throw into a failed result, never a lost one", async () => {
    startTaskLoop("t12", "task", {
      sendStep: async () => {
        throw new Error("unexpected transport explosion");
      },
      resolveTabId: async () => 1,
    });

    await vi.waitFor(() => expect(loopResult("t12")).not.toBeNull());
    expect(loopResult("t12")!.status).toBe("failed");
    expect(loopResult("t12")!.detail).toContain("unexpected transport explosion");
  });

  it("truncates history fields so a long outcome cannot bloat the payload", async () => {
    const seams = scripted(
      report({ state: "executed", outcome: "x".repeat(500), pageIdent: "y".repeat(500) }),
      report({ state: "done", actionType: "done" }),
    );
    const result = await runTaskLoop("t10", "task", seams);

    expect(result.history[0]!.outcome.length).toBeLessThanOrEqual(120);
    expect(result.history[0]!.page_ident.length).toBeLessThanOrEqual(120);
  });
});
