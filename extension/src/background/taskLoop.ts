import browser from "webextension-polyfill";
import { appendAudit } from "./audit";
import type { HistoryStep } from "../schemas/screenState";
import { describeError } from "../shared/errors";
import type { LoopResult, Reply, StepReport, ToContent } from "../shared/messages";

/**
 * The multi-step loop controller: perceive -> act -> settle -> perceive again.
 *
 * It lives in the background worker because the content script dies with every
 * navigation: only this context survives a click that loads a new page. Each step is one
 * message to the content script, which runs the full single-step pipeline (bot-check,
 * perceive, firewall, reason, risk gate, execute) and reports back a privacy-safe
 * `StepReport`. The controller adds what a single step cannot know: the budget, the
 * accumulated history, cancellation, and patience across page loads.
 *
 * Termination is explicit and total - every loop ends in exactly one of: `done`,
 * `blocked` (bot challenge, login wall, or the model saying it cannot proceed),
 * `declined` (user said no at the risk gate - a decision, not an error), `cancelled`
 * (user pressed stop), `no_progress`, `failed`, or `budget_exhausted`. There is no path
 * that loops forever, and a bot challenge is never retried: detected means stopped.
 */

/**
 * Steps a task may take. High enough for real workflows (search -> result -> cart ->
 * checkout is four), low enough that a confused model cannot burn an evening. The step
 * counter is also sent to the server, so the model knows how much rope is left.
 */
export const STEP_BUDGET = 15;

/** How long to keep re-trying the step message while a navigation settles. */
const SETTLE_TIMEOUT_MS = 20_000;
const SETTLE_RETRY_MS = 500;

/** Identical no-progress steps tolerated before concluding the loop is spinning. */
const MAX_STALLED_STEPS = 2;

const cancelled = new Set<string>();

/** Marks a running task as cancelled; the loop checks between steps. */
export function cancelTask(taskId: string): void {
  cancelled.add(taskId);
}

/**
 * Finished loops, kept for the popup to poll.
 *
 * The popup cannot simply await the run-loop message: a loop runs for minutes, and Chrome
 * closes a sendMessage reply channel long before that ("message channel closed before a
 * response was received"). So `startTaskLoop` returns immediately, the result lands here,
 * and the popup polls `loopResult` until it is non-null. Bounded so a long-lived worker
 * does not accumulate every task it ever ran.
 */
const results = new Map<string, LoopResult>();
const MAX_KEPT_RESULTS = 20;

/** Fires the loop without awaiting it; any escape-hatch throw becomes a `failed` result. */
export function startTaskLoop(taskId: string, task: string, seams: LoopSeams = {}): void {
  results.delete(taskId);
  void runTaskLoop(taskId, task, seams)
    .catch(
      (error): LoopResult => ({
        taskId,
        status: "failed",
        steps: 0,
        detail: describeError(error).message,
        history: [],
      }),
    )
    .then((result) => {
      results.set(taskId, result);
      for (const key of results.keys()) {
        if (results.size <= MAX_KEPT_RESULTS) break;
        results.delete(key);
      }
    });
}

/** The terminal result of a loop, or null while it is still running (or unknown). */
export function loopResult(taskId: string): LoopResult | null {
  return results.get(taskId) ?? null;
}

/**
 * Step reports that arrived out-of-band, keyed `taskId:step`.
 *
 * When a step's action navigates, the content script dies before it can answer on the
 * message channel - Chrome surfaces that to the sender as "message channel closed". The
 * content script therefore fires a copy of the report the instant the action executes,
 * before its first post-execution await; it lands here, and `sendWithSettle` prefers it
 * over re-sending the step to the freshly loaded page (which would re-perceive, re-reason
 * and act a second time for the same step).
 */
const stashedReports = new Map<string, StepReport>();

export function stashStepReport(taskId: string, step: number, report: StepReport): void {
  stashedReports.set(`${taskId}:${step}`, report);
}

function takeStashedReport(taskId: string, step: number): StepReport | undefined {
  const key = `${taskId}:${step}`;
  const report = stashedReports.get(key);
  if (report) stashedReports.delete(key);
  return report;
}

export interface LoopSeams {
  /** Sends one step to the content script; injectable so tests need no browser. */
  sendStep?: (tabId: number, message: ToContent) => Promise<Reply<StepReport>>;
  resolveTabId?: () => Promise<number>;
  stepBudget?: number;
  settleTimeoutMs?: number;
}

async function defaultSendStep(tabId: number, message: ToContent): Promise<Reply<StepReport>> {
  return (await browser.tabs.sendMessage(tabId, message)) as Reply<StepReport>;
}

/**
 * Sends the step, retrying while the tab is mid-navigation.
 *
 * After an executed click or navigate the old document - and the content script inside
 * it - may already be gone. The manifest re-injects at `document_idle` on the new page,
 * so "Receiving end does not exist" here usually means "not yet": retry until the new
 * script answers or the settle window closes. This replaces `tabs.onUpdated`
 * bookkeeping with something that also covers SPAs, which navigate without ever firing
 * a top-level load.
 */
async function sendWithSettle(
  send: (tabId: number, message: ToContent) => Promise<Reply<StepReport>>,
  tabId: number,
  message: Extract<ToContent, { type: "privagent/loop-step" }>,
  timeoutMs: number,
): Promise<Reply<StepReport>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A report that arrived out-of-band means this step already ran to completion and
    // only its reply was lost to the navigation. Using it - never re-sending - is what
    // keeps one step from acting twice.
    const stashed = takeStashedReport(message.taskId, message.step.n);
    if (stashed) return { ok: true, value: stashed };
    try {
      const reply = await send(tabId, message);
      if (reply) return reply;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // "channel closed" is the navigating-click case: the content script died mid-step.
      // Retry iterations then pick up the stashed report above, or - if even that copy
      // was lost - re-send once the new page's content script is listening.
      if (!/receiving end|could not establish|message port|channel closed/i.test(text)) {
        throw error;
      }
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: {
          code: "execution_failed",
          message: "The page did not finish loading a content script within the settle window",
        },
      };
    }
    await new Promise((done) => setTimeout(done, SETTLE_RETRY_MS));
  }
}

async function record(taskId: string, detail: string, ok = true): Promise<void> {
  try {
    await appendAudit({ taskId, stage: "act", detail, ok });
  } catch (error) {
    console.warn("PrivAgent loop audit write failed:", describeError(error).message);
  }
}

/** Runs one multi-step task to a terminal state. */
export async function runTaskLoop(
  taskId: string,
  task: string,
  seams: LoopSeams = {},
): Promise<LoopResult> {
  const send = seams.sendStep ?? defaultSendStep;
  const budget = seams.stepBudget ?? STEP_BUDGET;
  const settleMs = seams.settleTimeoutMs ?? SETTLE_TIMEOUT_MS;
  const history: HistoryStep[] = [];
  let stalled = 0;

  const finish = async (status: LoopResult["status"], detail: string): Promise<LoopResult> => {
    cancelled.delete(taskId);
    // Steps whose reply arrived normally leave their out-of-band copy behind; drop them.
    for (const key of stashedReports.keys()) {
      if (key.startsWith(`${taskId}:`)) stashedReports.delete(key);
    }
    await record(taskId, `loop finished: ${status} - ${detail}`, status === "done");
    return { taskId, status, steps: history.length, detail, history };
  };

  for (let n = 1; n <= budget; n += 1) {
    if (cancelled.has(taskId)) return finish("cancelled", "stopped by the user");

    let tabId: number;
    try {
      tabId = seams.resolveTabId ? await seams.resolveTabId() : await defaultResolveTabId();
    } catch (error) {
      return finish("failed", describeError(error).message);
    }

    const reply = await sendWithSettle(
      send,
      tabId,
      // History is snapshotted per step: `tabs.sendMessage` structured-clones anyway,
      // but an injected test seam would otherwise see a live, still-mutating array.
      {
        type: "privagent/loop-step",
        taskId,
        task,
        step: { n, limit: budget },
        history: [...history],
      },
      settleMs,
    );
    if (!reply.ok) return finish("failed", `step ${n}: ${reply.error.message}`);

    const report = reply.value;
    history.push({
      action: report.actionType,
      target_role: report.targetRole,
      outcome: report.outcome.slice(0, 120),
      page_ident: report.pageIdent.slice(0, 120),
    });

    switch (report.state) {
      case "done":
        return finish("done", report.outcome);
      case "blocked":
        return finish("blocked", report.blockedReason ?? report.outcome);
      case "declined":
        return finish("declined", "the user denied a proposed action");
      case "failed":
        return finish("failed", `step ${n}: ${report.outcome}`);
      case "none":
        // The model saw nothing useful to do. Once is a hint; repeatedly is a stall -
        // the same screen will keep producing the same answer.
        stalled += 1;
        if (stalled >= MAX_STALLED_STEPS) {
          return finish("no_progress", "no actionable element was found on consecutive steps");
        }
        break;
      case "executed":
        stalled = 0;
        break;
    }
  }

  return finish("budget_exhausted", `stopped after ${budget} steps without a done signal`);
}

async function defaultResolveTabId(): Promise<number> {
  // Same policy as single-shot tasks: the active http(s) tab, wherever it lives.
  const hostable = (tab: browser.Tabs.Tab) =>
    tab.id !== undefined && /^https?:/.test(tab.url ?? "");
  const inWindow = (await browser.tabs.query({ currentWindow: true })).filter(hostable);
  const anywhere = (await browser.tabs.query({})).filter(hostable);
  const target =
    inWindow.find((tab) => tab.active) ??
    anywhere.find((tab) => tab.active) ??
    [...inWindow, ...anywhere].sort(
      (left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0),
    )[0];
  if (!target?.id) {
    throw new Error("No web page tab to run the task against - open the page first");
  }
  return target.id;
}
