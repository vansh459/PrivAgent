import browser from "webextension-polyfill";
import { effectiveRisk, executeAction, requiresConfirmation } from "./actions";
import { confirmAction } from "./confirm";
import { perceiveDom } from "./domWalker";
import { fuseScreenElements } from "./fusion";
import { prepareContext } from "./pipeline";
import { tryVisionPass, type VisionPassOptions } from "./visionPass";
import { parseAction } from "../schemas/screenState";
import type { Action, RiskTier } from "../schemas/screenState";
import { describeError, PrivAgentError } from "../shared/errors";
import type { AuditStage, Reply, TaskSummary, ToBackground, ToContent } from "../shared/messages";

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
}

async function runTask(
  taskId: string,
  task: string,
  options: RunOptions = {},
): Promise<TaskSummary> {
  const confirm = options.confirm ?? confirmAction;
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

  const prepared = prepareContext(task, elements);
  await audit(
    taskId,
    "detect_pii",
    `${prepared.redactedElements} of ${elements.length} elements matched a PII detector`,
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

  if (requiresConfirmation(risk) && !(await confirm(action, risk))) {
    await audit(taskId, "act", "user denied the proposed action", false);
    return summarize(taskId, task, elements.length, vision, prepared, action, "denied_by_user");
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
        : `${outcome.reason}: ${outcome.detail}`;
  await audit(taskId, "act", detail, outcome.status !== "failed");

  return summarize(taskId, task, elements.length, vision, prepared, action, outcome.status);
}

function summarize(
  taskId: string,
  task: string,
  observed: number,
  vision: { elements: unknown[]; faces: number },
  prepared: ReturnType<typeof prepareContext>,
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

async function handleTask(request: ToContent): Promise<Reply<TaskSummary>> {
  try {
    return { ok: true, value: await runTask(request.taskId, request.task) };
  } catch (error) {
    const described = describeError(error);
    await audit(request.taskId, "act", `pipeline failed: ${described.code}`, false);
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
  if (request?.type !== "privagent/execute-task") return undefined;
  return handleTask(request);
});

export { runTask };
