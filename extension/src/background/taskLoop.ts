import browser from "webextension-polyfill";
import { appendAudit } from "./audit";
import type { Action, HistoryStep, SanitizedContext } from "../schemas/screenState";
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

/** How long to keep re-trying DELIVERY of the step message while a navigation settles. */
const SETTLE_TIMEOUT_MS = 20_000;
const SETTLE_RETRY_MS = 500;

/**
 * How long a DELIVERED step may work before the loop gives up on its result.
 *
 * A step's wall time is dominated by the reasoner: a frontier model takes 5-10 s, its
 * one validation retry doubles that, and the client's own fetch timeout is 45 s - so a
 * legitimate step can run well past any "is the page loading" horizon. This deadline
 * only matters when the reply channel died mid-step (the page navigated); the result
 * then arrives out-of-band, and this is how long the loop waits for it.
 */
const STEP_RESULT_TIMEOUT_MS = 120_000;

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

/**
 * Loops currently running, so a REOPENED popup can find its way back.
 *
 * A toolbar popup dies on any focus loss, taking its polling with it - but not the loop,
 * which lives here. Without this record a reopened popup shows "Ready." while an agent is
 * actively working, which reads as "the run died". `activeLoop()` answers the popup's
 * first question on open: is something running that I should re-attach to?
 */
const activeLoops = new Map<string, { task: string; startedAt: number }>();

/** The most recently started loop that is still running, or null. */
export function activeLoop(): { taskId: string; task: string } | null {
  let latest: { taskId: string; task: string; startedAt: number } | undefined;
  for (const [taskId, entry] of activeLoops) {
    if (!latest || entry.startedAt > latest.startedAt) {
      latest = { taskId, task: entry.task, startedAt: entry.startedAt };
    }
  }
  return latest ? { taskId: latest.taskId, task: latest.task } : null;
}

/** Fires the loop without awaiting it; any escape-hatch throw becomes a `failed` result. */
export function startTaskLoop(taskId: string, task: string, seams: LoopSeams = {}): void {
  results.delete(taskId);
  activeLoops.set(taskId, { task, startedAt: Date.now() });
  void runTaskLoop(taskId, task, seams)
    .catch((error): LoopResult => ({
      taskId,
      status: "failed",
      steps: 0,
      detail: describeError(error).message,
      history: [],
    }))
    .then((result) => {
      activeLoops.delete(taskId);
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

/**
 * What the reasoner proposed for each in-flight step, recorded by the service worker's
 * own `/reason` hop - the one part of a step that ALWAYS transits the background.
 *
 * This is the loop's independent witness. A navigating click kills the content script,
 * and everything that page still owed us - the reply, the audit "act" line, even the
 * fire-and-forget report copy - can die with it (observed live: Chrome dropped the
 * out-of-band message from the unloading document). But the background already knows
 * what the step was about to do, because it fetched the proposal itself. When the reply
 * channel dies after a click/navigate proposal, the loop can conclude "executed, page
 * navigating" from its own records instead of waiting on a dead document.
 */
interface ProposedStep {
  action: Action["action"];
  targetRole: string | null;
  pageIdent: string;
  task: string;
  /** True when the proposal was a type with params.submit - Enter navigates like a click. */
  submits: boolean;
}

/** Could executing this proposal have destroyed the page it ran on? */
function proposalNavigates(proposal: ProposedStep): boolean {
  return (
    proposal.action === "click" ||
    proposal.action === "navigate" ||
    (proposal.action === "type" && proposal.submits)
  );
}

const proposals = new Map<string, ProposedStep>();

/** Called by the service worker after every successful /reason round-trip. */
export function noteProposedAction(
  taskId: string,
  context: SanitizedContext,
  action: Action,
): void {
  if (!context.step) return; // single-shot tasks have no loop to rescue
  const targetRole = action.target_id
    ? (context.elements.find((element) => element.mark_id === action.target_id)?.role ?? null)
    : null;
  proposals.set(`${taskId}:${context.step.n}`, {
    action: action.action,
    targetRole,
    pageIdent: context.page_ident ?? "",
    task: context.task,
    submits: action.params?.submit === "true",
  });
}

function peekProposal(taskId: string, step: number): ProposedStep | undefined {
  return proposals.get(`${taskId}:${step}`);
}

/**
 * The exact sanitized payloads the latest task sent to the reasoner.
 *
 * Kept so the popup can SHOW the redaction instead of merely counting it: every element
 * the AI received, with "[PII_*]" tokens standing where private values were. Displaying
 * this is safe by definition - it is precisely what already crossed the wire. Only the
 * latest task is kept, capped at the step budget; withheld elements are, by design, not
 * here to show.
 */
let sentTaskId: string | null = null;
let sentContexts: SanitizedContext[] = [];

/** Called by the service worker for every outbound /reason payload. */
export function recordSentContext(taskId: string, context: SanitizedContext): void {
  if (taskId !== sentTaskId) {
    sentTaskId = taskId;
    sentContexts = [];
  }
  sentContexts.push(context);
  if (sentContexts.length > STEP_BUDGET) sentContexts.shift();
}

/** The recorded payloads for a task - empty unless it is the latest task. */
export function sentPayloads(taskId: string): SanitizedContext[] {
  return taskId === sentTaskId ? [...sentContexts] : [];
}

/** How long a died channel waits for the true report before synthesizing from the proposal. */
const SYNTH_GRACE_MS = 3_000;

/** How long loop start retries tab resolution across Firefox's about:blank transients. */
const RESOLVE_TIMEOUT_MS = 6_000;
const RESOLVE_RETRY_MS = 300;

function synthesizeReport(taskId: string, proposal: ProposedStep): StepReport {
  return {
    state: "executed",
    actionType: proposal.action,
    targetRole: proposal.targetRole,
    outcome: `executed ${proposal.action}`,
    pageIdent: proposal.pageIdent,
    summary: {
      taskId,
      task: proposal.task,
      observed: 0,
      perceivedByVision: 0,
      facesDetected: 0,
      transmitted: 0,
      redactedElements: 0,
      withheldForReview: 0,
      action: null,
      outcome: "executed",
    },
  };
}

export interface LoopSeams {
  /** Sends one step to the content script; injectable so tests need no browser. */
  sendStep?: (tabId: number, message: ToContent) => Promise<Reply<StepReport>>;
  resolveTabId?: () => Promise<number>;
  stepBudget?: number;
  settleTimeoutMs?: number;
  stepResultTimeoutMs?: number;
  synthGraceMs?: number;
  resolveTimeoutMs?: number;
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
  settleTimeoutMs: number,
  stepResultTimeoutMs: number,
  synthGraceMs: number,
): Promise<Reply<StepReport>> {
  // Chrome's two failure strings draw exactly the line this function needs: "receiving
  // end does not exist" means the message was never delivered (no content script yet -
  // safe to send again), while "channel/port closed" means a content script HAD the
  // message and its document died before answering. What happens next depends on how far
  // that step got, which the background can tell from its own records:
  //   - report stashed        -> the step finished; use its real report.
  //   - /reason proposal that navigates (click, navigate, type+submit) -> the action ran
  //     and killed its own page; synthesize "executed" from the proposal.
  //   - NO proposal           -> the step died before reasoning, so it provably did
  //     nothing: delivering it again to the new document is safe (observed live: a
  //     search-results page redirected itself mid-perception).
  //   - a non-navigating proposal -> ambiguous (the action may or may not have run);
  //     never re-send, wait for the stash until the deadline.
  // The absolute cap keeps a page stuck in a redirect loop from holding a step forever.
  let deadline = Date.now() + settleTimeoutMs;
  let hardDeadline = Number.POSITIVE_INFINITY;
  let delivered = false;
  let deliveredAt = 0;
  for (;;) {
    const stashed = takeStashedReport(message.taskId, message.step.n);
    if (stashed) return { ok: true, value: stashed };
    if (delivered && Date.now() - deliveredAt >= synthGraceMs) {
      const proposal = peekProposal(message.taskId, message.step.n);
      if (proposal && proposalNavigates(proposal)) {
        return { ok: true, value: synthesizeReport(message.taskId, proposal) };
      }
      if (!proposal) {
        delivered = false;
        deadline = Math.min(Date.now() + settleTimeoutMs, hardDeadline);
      }
    }
    if (!delivered) {
      try {
        const reply = await send(tabId, message);
        if (reply) return reply;
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (/message port|channel closed/i.test(text)) {
          delivered = true;
          deliveredAt = Date.now();
          if (hardDeadline === Number.POSITIVE_INFINITY) {
            hardDeadline = deliveredAt + stepResultTimeoutMs;
          }
          deadline = Math.min(deliveredAt + stepResultTimeoutMs, hardDeadline);
        } else if (!/receiving end|could not establish/i.test(text)) {
          throw error;
        }
      }
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: {
          code: "execution_failed",
          message: delivered
            ? `the step was delivered but produced no result within ${stepResultTimeoutMs} ms`
            : "The page did not finish loading a content script within the settle window",
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
  const stepResultMs = seams.stepResultTimeoutMs ?? STEP_RESULT_TIMEOUT_MS;
  const synthGraceMs = seams.synthGraceMs ?? SYNTH_GRACE_MS;
  const history: HistoryStep[] = [];
  let stalled = 0;

  const finish = async (status: LoopResult["status"], detail: string): Promise<LoopResult> => {
    cancelled.delete(taskId);
    // Steps whose reply arrived normally leave their out-of-band copy behind; drop them,
    // along with the /reason proposals recorded for this task.
    for (const key of stashedReports.keys()) {
      if (key.startsWith(`${taskId}:`)) stashedReports.delete(key);
    }
    for (const key of proposals.keys()) {
      if (key.startsWith(`${taskId}:`)) proposals.delete(key);
    }
    await record(taskId, `loop finished: ${status} - ${detail}`, status === "done");
    return { taskId, status, steps: history.length, detail, history };
  };

  // The tab is resolved ONCE and pinned for the whole task. Re-resolving per step is
  // wrong twice over: mid-navigation Firefox transiently reports the tab's URL as
  // about:blank, so a step landing in that window finds "no web page tab" (observed
  // failing ~6/7 loop runs in real Firefox); and if the user focuses another tab while
  // the loop works, the task must keep acting on the page it started on, not follow the
  // user's attention to an unrelated one. A tab id is stable across navigations.
  //
  // Resolution itself is retried for a few seconds: the same about:blank transient can
  // hit the ONE resolution too - a tab that was just (re)loaded shows no URL for a
  // moment, and failing the whole task over a blink the user cannot even see is wrong
  // (observed live in Firefox: "No web page tab" with a website plainly open).
  const resolve = seams.resolveTabId ?? defaultResolveTabId;
  const resolveDeadline = Date.now() + (seams.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS);
  let tabId: number;
  for (;;) {
    try {
      tabId = await resolve();
      break;
    } catch (error) {
      if (Date.now() >= resolveDeadline) {
        return finish("failed", describeError(error).message);
      }
      await new Promise((done) => setTimeout(done, RESOLVE_RETRY_MS));
    }
  }

  for (let n = 1; n <= budget; n += 1) {
    if (cancelled.has(taskId)) return finish("cancelled", "stopped by the user");

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
      stepResultMs,
      synthGraceMs,
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
