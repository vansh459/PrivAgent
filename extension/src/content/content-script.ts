import browser from "webextension-polyfill";
import { effectiveRisk, executeAction, requiresConfirmation } from "./actions";
import { detectBotBlock } from "./botBlock";
import { confirmAction } from "./confirm";
import { perceiveDom } from "./domWalker";
import { fuseScreenElements } from "./fusion";
import { prepareContext, type NameVerifierFn, type PreparedContext } from "./pipeline";
import { tryVisionPass, type VisionPassOptions } from "./visionPass";
import { parseAction } from "../schemas/screenState";
import type { Action, HistoryStep, RiskTier, StepInfo } from "../schemas/screenState";
import { describeError, PrivAgentError } from "../shared/errors";
import type {
  AuditStage,
  Reply,
  StepReport,
  TaskSummary,
  ToBackground,
  ToContent,
} from "../shared/messages";

/**
 * Content script: the perceive -> redact -> reason -> validate -> act loop.
 *
 * Everything privacy-sensitive happens before the single call to the background worker;
 * by the time `privagent/reason` is sent, the payload has already been through the
 * Privacy Firewall and contains only Set-of-Mark tagged, task-relevant elements.
 */

async function send<T>(message: ToBackground): Promise<T> {
  const reply = (await browser.runtime.sendMessage(message)) as Reply<T>;
  if (!reply?.ok) {
    throw new PrivAgentError(
      reply?.error?.code ?? "execution_failed",
      reply?.error?.message ?? "Background worker did not respond",
    );
  }
  return reply.value;
}

/** Records a stage. Details are counts and statuses only - never observed values. */
async function audit(taskId: string, stage: AuditStage, detail: string, ok = true): Promise<void> {
  try {
    await send({ type: "privagent/audit", entry: { taskId, stage, detail, ok } });
  } catch (error) {
    console.warn("PrivAgent audit write failed:", describeError(error).message);
  }
}

export interface RunOptions {
  /** Injectable so tests can drive the gate; the real one renders a closed shadow root. */
  confirm?: (action: Action, risk: RiskTier) => Promise<boolean>;
  /** Injectable capture/detect/read seams, so the loop is testable without a browser. */
  vision?: VisionPassOptions;
  /** Injectable NER name verifier; the real one runs in the extension-origin vision host. */
  verifyNames?: NameVerifierFn;
}

/**
 * Default name verifier: the candidates travel to the background worker, which hosts the
 * model in the same extension-origin document the vision pass uses. `prepareContext`
 * treats any failure here as "confirm everything", so an unreachable host costs precision
 * only, never recall.
 */
const verifyNamesInHost: NameVerifierFn = (items) =>
  send<boolean[][]>({ type: "privagent/verify-names", items });

/** The loop controller's per-step context: which step this is, and what came before. */
interface LoopStepContext {
  step: StepInfo;
  history: HistoryStep[];
}

async function runTask(
  taskId: string,
  task: string,
  options: RunOptions = {},
): Promise<TaskSummary> {
  return (await runStep(taskId, task, options)).summary;
}

async function runStep(
  taskId: string,
  task: string,
  options: RunOptions = {},
  loop?: LoopStepContext,
): Promise<{ summary: TaskSummary; report: StepReport }> {
  const confirm = options.confirm ?? confirmAction;

  // Bot-check gate, before a single pixel or element is read: a site that presents an
  // automation challenge is answered by stopping, never by working around it.
  const bot = detectBotBlock();
  if (bot.blocked) {
    await audit(
      taskId,
      "observe",
      `automation challenge detected (${bot.marker}); stopping`,
      false,
    );
    const summary = emptySummary(taskId, task, "blocked_by_site");
    return {
      summary,
      report: {
        state: "blocked",
        actionType: "blocked",
        targetRole: null,
        outcome: `blocked by site (${bot.marker})`,
        pageIdent: "",
        blockedReason: "bot_detection",
        summary,
      },
    };
  }

  const { elements: domElements, refs } = perceiveDom();

  // Vision runs before redaction, not after: text read out of a canvas is exactly as
  // sensitive as text read out of the DOM, and has to enter the Privacy Firewall by the
  // same door. Fusing first is what guarantees it cannot bypass it.
  const vision = await tryVisionPass(options.vision);
  const elements = fuseScreenElements(domElements, vision.elements);

  await audit(
    taskId,
    "observe",
    `perceived ${domElements.length} interactive elements; ` +
      (vision.error
        ? `vision unavailable (${vision.error})`
        : vision.captured
          ? `vision read ${vision.regionsRead} region(s), found ${vision.faces} face(s) ` +
            `and masked ${vision.pixelsRedacted} pixel(s) ` +
            `in ${vision.millis} ms ` +
            `[decode ${vision.timings.decodeMs}, detect ${vision.timings.detectMs}, ` +
            `ocr ${vision.timings.ocrMs}]`
          : "no visual regions to capture") +
      `; ${elements.length} after fusion`,
    !vision.error,
  );

  const prepared = await prepareContext(task, elements, {
    verifyNames: options.verifyNames ?? verifyNamesInHost,
    loop,
  });

  // The page's identity for the step history: its title, through the same firewall as
  // everything else, truncated. Never the URL - that stays on the never-transmitted list.
  const pageIdent = prepared.tokens.redact(document.title ?? "").text.slice(0, 120);
  await audit(
    taskId,
    "detect_pii",
    `${prepared.redactedElements} of ${elements.length} elements matched a PII detector` +
      (prepared.namesRejected > 0
        ? `; ${prepared.namesRejected} name candidate(s) released by the NER verifier`
        : ""),
  );
  await audit(
    taskId,
    "redact",
    `${prepared.tokens.size} values tokenized; ` +
      `${prepared.withheldForReview} elements withheld for review; ` +
      `${prepared.context.elements.length} marks transmitted`,
  );

  const action = parseAction(
    await send({ type: "privagent/reason", taskId, context: prepared.context }),
  );

  const targetElementId = action.target_id ? prepared.marks.get(action.target_id) : undefined;
  const targetSensitive = elements.some(
    (element) => element.id === targetElementId && element.sensitive,
  );
  const risk = effectiveRisk(action, targetSensitive);
  await audit(taskId, "validate", `effective risk=${risk} (server proposed ${action.risk})`);

  const targetRole =
    prepared.context.elements.find((element) => element.mark_id === action.target_id)?.role ?? null;

  if (requiresConfirmation(risk) && !(await confirm(action, risk))) {
    await audit(taskId, "act", "user denied the proposed action", false);
    const summary = summarize(
      taskId,
      task,
      elements.length,
      vision,
      prepared,
      action,
      "denied_by_user",
    );
    return {
      summary,
      report: {
        state: "declined",
        actionType: action.action,
        targetRole,
        outcome: "denied by user",
        pageIdent,
        summary,
      },
    };
  }

  const marks = new Map<string, HTMLElement>();
  for (const [markId, elementId] of prepared.marks) {
    const node = refs.get(elementId);
    if (node) marks.set(markId, node);
  }

  const outcome = executeAction(action, marks);
  const detail =
    outcome.status === "executed"
      ? `executed ${outcome.action}`
      : outcome.status === "skipped"
        ? "no action proposed"
        : outcome.status === "done"
          ? "task reported done"
          : outcome.status === "blocked"
            ? `stopped: ${outcome.reason}`
            : `${outcome.reason}: ${outcome.detail}`;

  const summary = summarize(
    taskId,
    task,
    elements.length,
    vision,
    prepared,
    action,
    outcome.status,
  );
  const state: StepReport["state"] =
    outcome.status === "executed"
      ? "executed"
      : outcome.status === "skipped"
        ? "none"
        : outcome.status === "done"
          ? "done"
          : outcome.status === "blocked"
            ? "blocked"
            : "failed";
  const report: StepReport = {
    state,
    actionType: action.action,
    targetRole,
    outcome: detail,
    pageIdent,
    ...(outcome.status === "blocked" ? { blockedReason: outcome.reason } : {}),
    summary,
  };

  // An executed click may already be navigating this page away. Everything below this
  // line - the audit write, the reply on the message channel - is an await the unloading
  // document may never come back from, so the finished report is fired to the background
  // out-of-band FIRST, with nothing awaited before it. The loop controller falls back to
  // this copy when the reply channel dies mid-navigation.
  if (loop) {
    void browser.runtime
      .sendMessage({
        type: "privagent/step-result",
        taskId,
        step: loop.step.n,
        report,
      } satisfies ToBackground)
      .catch(() => undefined);
  }

  await audit(taskId, "act", detail, outcome.status !== "failed");
  return { summary, report };
}

/** A summary for a step that stopped before perceiving anything. */
function emptySummary(taskId: string, task: string, outcome: string): TaskSummary {
  return {
    taskId,
    task,
    observed: 0,
    perceivedByVision: 0,
    facesDetected: 0,
    transmitted: 0,
    redactedElements: 0,
    withheldForReview: 0,
    action: null,
    outcome,
  };
}

function summarize(
  taskId: string,
  task: string,
  observed: number,
  vision: { elements: unknown[]; faces: number },
  prepared: PreparedContext,
  action: TaskSummary["action"],
  outcome: string,
): TaskSummary {
  return {
    taskId,
    task,
    observed,
    perceivedByVision: vision.elements.length,
    facesDetected: vision.faces,
    transmitted: prepared.context.elements.length,
    redactedElements: prepared.redactedElements,
    withheldForReview: prepared.withheldForReview,
    action,
    outcome,
  };
}

async function handleTask(
  request: Extract<ToContent, { type: "privagent/execute-task" }>,
): Promise<Reply<TaskSummary>> {
  try {
    return { ok: true, value: await runTask(request.taskId, request.task) };
  } catch (error) {
    const described = describeError(error);
    await audit(request.taskId, "act", `pipeline failed: ${described.code}`, false);
    return { ok: false, error: described };
  }
}

async function handleLoopStep(
  request: Extract<ToContent, { type: "privagent/loop-step" }>,
): Promise<Reply<StepReport>> {
  try {
    const { report } = await runStep(
      request.taskId,
      request.task,
      {},
      {
        step: request.step,
        history: request.history,
      },
    );
    return { ok: true, value: report };
  } catch (error) {
    const described = describeError(error);
    await audit(request.taskId, "act", `step failed: ${described.code}`, false);
    return { ok: false, error: described };
  }
}

/**
 * `runtime.sendMessage` broadcasts to every extension context, so this listener also sees
 * messages the popup addressed to the background worker. Returning `undefined` - rather
 * than an error reply - leaves them unanswered here, so the intended recipient's response
 * is the one the sender receives. Answering them would win the race and break the popup.
 */
browser.runtime.onMessage.addListener((message: unknown) => {
  const request = message as ToContent;
  if (request?.type === "privagent/execute-task") return handleTask(request);
  if (request?.type === "privagent/loop-step") return handleLoopStep(request);
  return undefined;
});

export { runTask, runStep };
