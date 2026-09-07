import { describe, expect, it, vi, type Mock } from "vitest";

vi.mock("webextension-polyfill", () => ({
  default: { runtime: {}, tabs: { sendMessage: vi.fn(), query: vi.fn() } },
}));
import browser from "webextension-polyfill";
// The audit store needs IndexedDB; these tests inject seams and only need it to no-op.
vi.mock("../src/background/audit", () => ({ appendAudit: vi.fn().mockResolvedValue({}) }));

import {
  activeLoop,
  cancelTask,
  loopResult,
  noteProposedAction,
  runTaskLoop,
  startTaskLoop,
  stashStepReport,
  STEP_BUDGET,
} from "../src/background/taskLoop";
import type { Action, SanitizedContext } from "../src/schemas/screenState";
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
      resolveTimeoutMs: 0,
    });
    expect(noTab.status).toBe("failed");
  });

  it("synthesizes an executed step from the /reason record when the page's report is lost", async () => {
    const CHANNEL_CLOSED =
      "A listener indicated an asynchronous response by returning true, " +
      "but the message channel closed before a response was received";
    const context = (step: number): SanitizedContext => ({
      schema_version: "1.1",
      task: "open the report page",
      elements: [{ mark_id: "M1", role: "link", text: "Open the report page", bbox: [0, 0, 9, 9] }],
      step: { n: step, limit: 15 },
      history: [],
      page_ident: "Quarterly Reports Portal",
    });
    const proposed: Action = {
      action: "click",
      target_id: "M1",
      params: {},
      confidence: 0.95,
      risk: "low",
      explanation: "Opening the report page.",
      reasoning_trace_id: "trace_t21",
    };

    const sentSteps: number[] = [];
    const sendStep = async (_tab: number, message: ToContent): Promise<Reply<StepReport>> => {
      const step = (message as Extract<ToContent, { type: "privagent/loop-step" }>).step.n;
      sentSteps.push(step);
      if (step === 1) {
        // The step reasoned (the background recorded the proposal), clicked, and died -
        // and unlike the stash tests, NO out-of-band copy ever arrives.
        noteProposedAction("t21", context(1), proposed);
        throw new Error(CHANNEL_CLOSED);
      }
      return { ok: true, value: report({ state: "done", actionType: "done" }) };
    };

    const result = await runTaskLoop("t21", "open the report page", {
      sendStep,
      resolveTabId: async () => 1,
      synthGraceMs: 300,
    });

    expect(result.status).toBe("done");
    expect(sentSteps).toEqual([1, 2]); // never re-sent
    expect(result.history[0]).toEqual({
      action: "click",
      target_role: "link",
      outcome: "executed click",
      page_ident: "Quarterly Reports Portal",
    });
  });

  it("prefers the page's own report over synthesis when both survive", async () => {
    const context: SanitizedContext = {
      schema_version: "1.1",
      task: "task",
      elements: [{ mark_id: "M1", role: "link", text: "x", bbox: [0, 0, 1, 1] }],
      step: { n: 1, limit: 15 },
      history: [],
    };
    const sendStep = async (): Promise<Reply<StepReport>> => {
      noteProposedAction("t22", context, {
        action: "click",
        target_id: "M1",
        params: {},
        confidence: 0.9,
        risk: "low",
        explanation: "x",
        reasoning_trace_id: "t",
      });
      // The real report lands BEFORE the channel error surfaces - the true record wins.
      stashStepReport("t22", 1, report({ state: "done", actionType: "done", outcome: "real" }));
      throw new Error("The message port closed before a response was received.");
    };
    const result = await runTaskLoop("t22", "task", {
      sendStep,
      resolveTabId: async () => 1,
      synthGraceMs: 10_000, // synthesis would need 10s; the stash must win immediately
    });

    expect(result.status).toBe("done");
    expect(result.detail).toBe("real");
  });

  it("never synthesizes for a non-navigating proposal: a dead typing step stays failed", async () => {
    const context: SanitizedContext = {
      schema_version: "1.1",
      task: "task",
      elements: [{ mark_id: "M1", role: "text_field", text: "", bbox: [0, 0, 1, 1] }],
      step: { n: 1, limit: 15 },
      history: [],
    };
    const sendStep = async (): Promise<Reply<StepReport>> => {
      noteProposedAction("t23", context, {
        action: "type",
        target_id: "M1",
        params: { text: "hello" },
        confidence: 0.9,
        risk: "low",
        explanation: "x",
        reasoning_trace_id: "t",
      });
      throw new Error("The message port closed before a response was received.");
    };
    const result = await runTaskLoop("t23", "task", {
      sendStep,
      resolveTabId: async () => 1,
      synthGraceMs: 100,
      stepResultTimeoutMs: 800,
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("no result");
  });

  it("never re-sends a delivered step: waits for the out-of-band report instead", async () => {
    const sentSteps: number[] = [];
    const sendStep = async (_tabId: number, message: ToContent): Promise<Reply<StepReport>> => {
      const step = (message as Extract<ToContent, { type: "privagent/loop-step" }>).step.n;
      sentSteps.push(step);
      if (step === 1) {
        // Delivered, then the navigating page died mid-step. The report arrives out of
        // band 600ms later - after the loop has already had a chance to (wrongly) re-send.
        setTimeout(() => stashStepReport("t18", 1, report({ state: "executed" })), 600);
        throw new Error(
          "A listener indicated an asynchronous response by returning true, " +
            "but the message channel closed before a response was received",
        );
      }
      return { ok: true, value: report({ state: "done", actionType: "done" }) };
    };

    const result = await runTaskLoop("t18", "task", { sendStep, resolveTabId: async () => 1 });

    expect(result.status).toBe("done");
    // Step 1 was sent exactly once - a delivered step must never execute twice.
    expect(sentSteps).toEqual([1, 2]);
  });

  it("keeps re-sending while delivery itself fails, then fails on the delivered deadline", async () => {
    let attempts = 0;
    const undeliverable = async (): Promise<Reply<StepReport>> => {
      attempts += 1;
      throw new Error("Could not establish connection. Receiving end does not exist.");
    };
    const failed = await runTaskLoop("t19", "task", {
      sendStep: undeliverable,
      resolveTabId: async () => 1,
      settleTimeoutMs: 1200,
    });
    expect(failed.status).toBe("failed");
    expect(failed.detail).toContain("settle window");
    expect(attempts).toBeGreaterThan(1); // undelivered IS re-sent

    const deliveredButSilent = async (): Promise<Reply<StepReport>> => {
      throw new Error("The message port closed before a response was received.");
    };
    const silent = await runTaskLoop("t20", "task", {
      sendStep: deliveredButSilent,
      resolveTabId: async () => 1,
      stepResultTimeoutMs: 800,
    });
    expect(silent.status).toBe("failed");
    expect(silent.detail).toContain("no result");
  });

  it("a stashed report rescues a step whose reply channel died mid-navigation", async () => {
    let calls = 0;
    const sendStep = async (): Promise<Reply<StepReport>> => {
      calls += 1;
      if (calls === 1) {
        // The content script's out-of-band copy lands, then the navigating page kills
        // the reply channel - exactly the order the real race produces.
        stashStepReport("t13", 1, report({ state: "executed" }));
        throw new Error(
          "A listener indicated an asynchronous response by returning true, " +
            "but the message channel closed before a response was received",
        );
      }
      return { ok: true, value: report({ state: "done", actionType: "done" }) };
    };
    const result = await runTaskLoop("t13", "cross a navigation", {
      sendStep,
      resolveTabId: async () => 1,
    });

    expect(result.status).toBe("done");
    expect(result.steps).toBe(2);
    expect(result.history[0]!.action).toBe("click");
    // Step 1 was never re-sent to the new page: the second send was step 2.
    expect(calls).toBe(2);
  });

  it("reports the running loop while it runs, and nothing once it finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const sendStep = async (): Promise<Reply<StepReport>> => {
      await gate; // holds the loop mid-step so "running" is observable
      return { ok: true, value: report({ state: "done", actionType: "done" }) };
    };

    startTaskLoop("t24", "reattachable task", { sendStep, resolveTabId: async () => 1 });
    await vi.waitFor(() => expect(activeLoop()?.taskId).toBe("t24"));
    // This is everything a reopened popup needs to adopt the run.
    expect(activeLoop()?.task).toBe("reattachable task");

    release();
    await vi.waitFor(() => expect(loopResult("t24")).not.toBeNull());
    expect(activeLoop()).toBeNull();
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

  it("without seams, resolves the active http(s) tab and messages it directly", async () => {
    (browser.tabs.query as Mock).mockResolvedValue([
      { id: 7, url: "chrome://settings", active: true, lastAccessed: 9 },
      { id: 3, url: "https://example.com", active: true, lastAccessed: 5 },
    ]);
    (browser.tabs.sendMessage as Mock).mockResolvedValue({
      ok: true,
      value: report({ state: "done", actionType: "done", outcome: "task reported done" }),
    });

    const result = await runTaskLoop("t14", "real transport task");

    expect(result.status).toBe("done");
    // The chrome:// tab can never host a content script; the http(s) one wins.
    expect((browser.tabs.sendMessage as Mock).mock.calls[0]![0]).toBe(3);
  });

  it("without seams, falls back to the most recently used tab and fails when none exist", async () => {
    (browser.tabs.query as Mock).mockResolvedValue([
      { id: 4, url: "https://old.example", active: false, lastAccessed: 10 },
      { id: 5, url: "https://new.example", active: false, lastAccessed: 20 },
    ]);
    (browser.tabs.sendMessage as Mock).mockResolvedValue({
      ok: true,
      value: report({ state: "done", actionType: "done" }),
    });
    const byRecency = await runTaskLoop("t15", "task");
    expect(byRecency.status).toBe("done");
    expect((browser.tabs.sendMessage as Mock).mock.lastCall![0]).toBe(5);

    (browser.tabs.query as Mock).mockResolvedValue([]);
    const noTab = await runTaskLoop("t16", "task", { resolveTimeoutMs: 0 });
    expect(noTab.status).toBe("failed");
    expect(noTab.detail).toContain("No web page tab");
  });

  it("gives up when the settle window closes without a content script answering", async () => {
    const sendStep = async (): Promise<Reply<StepReport>> => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    };
    const result = await runTaskLoop("t17", "task", {
      sendStep,
      resolveTabId: async () => 1,
      settleTimeoutMs: 0,
    });

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("settle window");
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
