import browser from "webextension-polyfill";
import { appendAudit, readAudit } from "./audit";
import { requestAction } from "./reason";
import {
  activeLoop,
  cancelTask,
  loopResult,
  noteProposedAction,
  recordSentContext,
  sentPayloads,
  startTaskLoop,
  stashStepReport,
} from "./taskLoop";
import { analyzeInHost, verifyNamesInHost, warmVisionHost } from "./vision";
import { getServerUrl } from "../shared/config";
import { describeError, PrivAgentError } from "../shared/errors";
import { fail, ok, type Reply, type ToBackground, type ToContent } from "../shared/messages";
import type { Action, SanitizedContext } from "../schemas/screenState";
import type { AuditEntry, LoopResult, TaskSummary } from "../shared/messages";
import type { VisionAnalysis, Viewport, VisualRegion } from "../vision/analyze";

/**
 * Background service worker: the extension's orchestrator and its only network caller.
 *
 * Three things must happen here rather than in the content script:
 *   - `tabs.captureVisibleTab` is only callable from an extension context;
 *   - the audit trail must be stored on the extension origin, not the page's;
 *   - `fetch` here uses the extension's host permissions instead of the page's CSP.
 */

browser.runtime.onInstalled.addListener(() => {
  console.info("PrivAgent service worker installed.");
});

async function reason(taskId: string, context: SanitizedContext): Promise<Action> {
  const serverUrl = await getServerUrl();
  // Recorded before the call: this is the outbound payload whether or not the server
  // answers, and it is what the popup's transparency panel shows the user.
  recordSentContext(taskId, context);
  const action = await requestAction(context, { serverUrl });
  // The loop's independent witness: if the step's page dies executing this action, the
  // controller reconstructs "executed <action>" from this record (see taskLoop.ts).
  noteProposedAction(taskId, context, action);
  await appendAudit({
    taskId,
    stage: "reason",
    ok: true,
    detail: `server proposed "${action.action}" risk=${action.risk} confidence=${action.confidence}`,
  });
  return action;
}

/**
 * Picks the tab a task should run against.
 *
 * The active tab is not always the right one: the popup can be open as its own tab, or
 * the user can be focused on a devtools or settings page. Only http(s) tabs can host a
 * content script, so those are the only candidates, preferring the active one and
 * otherwise the most recently used.
 */
async function resolveTargetTab(): Promise<browser.Tabs.Tab> {
  const hostable = (tab: browser.Tabs.Tab) =>
    tab.id !== undefined && /^https?:/.test(tab.url ?? "");
  const inWindow = (await browser.tabs.query({ currentWindow: true })).filter(hostable);
  // The popup can be its own window - a detached panel, or a second monitor - in which
  // case the page to act on is not in the calling window at all. Looking wider beats
  // telling the user there is no page open when there plainly is.
  const anywhere = (await browser.tabs.query({})).filter(hostable);

  const target =
    inWindow.find((tab) => tab.active) ??
    anywhere.find((tab) => tab.active) ??
    [...inWindow, ...anywhere].sort(
      (left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0),
    )[0];

  if (!target?.id) {
    throw new PrivAgentError(
      "execution_failed",
      "No web page tab to run the task against - open the page you want the agent to act on",
    );
  }
  return target;
}

/**
 * Screenshots the visible tab and has it analysed locally.
 *
 * `captureVisibleTab` is only callable from an extension context, which is why this hop
 * exists: the content script cannot screenshot its own tab. The image is handed to an
 * extension-origin document, analysed there, and discarded. It is never stored, never
 * returned to the page, and never sent anywhere - what eventually leaves the device is
 * some text and a few rectangles, after the Privacy Firewall has seen them.
 */
async function perceiveVision(
  regions: VisualRegion[],
  viewport: Viewport,
): Promise<VisionAnalysis> {
  const tab = await resolveTargetTab();

  // `captureVisibleTab` photographs whatever is *visible* in the window - it takes a
  // window id, not a tab id, and quietly ignores which tab you meant. If the task's tab
  // is not the visible one, the screenshot is of some other page the user happens to have
  // open, and every box in it lands on the wrong element. Worse, the agent would then be
  // running OCR and face detection over a page it was never asked to look at. Refusing is
  // the only correct answer; the caller reports vision as unavailable and carries on with
  // the DOM.
  if (!tab.active) {
    throw new PrivAgentError(
      "capability_unavailable",
      "The task's tab is not the visible one, and a screenshot would capture a different page",
    );
  }

  const dataUrl = await captureWithRetry(tab.windowId);
  if (!dataUrl) {
    throw new PrivAgentError("capability_unavailable", "The browser returned no screenshot");
  }
  return analyzeInHost(dataUrl, regions, viewport);
}

/**
 * Screenshots the window, retrying once when Chrome's capture quota rejects the call.
 *
 * `captureVisibleTab` is rate-limited to a couple of calls per second. Two tasks in quick
 * succession - which is exactly how someone uses an agent when it is working - would
 * otherwise have the second one silently lose its sight, reported as "vision unavailable"
 * for a reason that has nothing to do with the page. One retry after the quota window is
 * cheaper than a pass that saw nothing.
 */
async function captureWithRetry(windowId: number | undefined): Promise<string | undefined> {
  try {
    return await browser.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/quota|too many|MAX_CAPTURE/i.test(message)) throw error;
    await new Promise((done) => setTimeout(done, CAPTURE_QUOTA_WINDOW_MS));
    return browser.tabs.captureVisibleTab(windowId, { format: "png" });
  }
}

/** Chrome's capture quota is per second; this is that window plus a margin. */
const CAPTURE_QUOTA_WINDOW_MS = 1_200;

async function startTask(task: string): Promise<TaskSummary> {
  const tab = await resolveTargetTab();

  const taskId = crypto.randomUUID();
  const message: ToContent = { type: "privagent/execute-task", taskId, task };
  const reply = (await browser.tabs.sendMessage(tab.id!, message)) as Reply<TaskSummary>;
  if (!reply?.ok) {
    throw new PrivAgentError(
      reply?.error?.code ?? "execution_failed",
      reply?.error?.message ?? "The content script did not complete the task",
    );
  }
  return reply.value;
}

async function handle(message: ToBackground): Promise<Reply<unknown>> {
  switch (message.type) {
    case "privagent/reason":
      return ok<Action>(await reason(message.taskId, message.context));
    case "privagent/audit":
      return ok<AuditEntry>(await appendAudit(message.entry));
    case "privagent/read-audit":
      return ok<AuditEntry[]>(await readAudit(message.taskId));
    case "privagent/run-task":
      return ok<TaskSummary>(await startTask(message.task));
    case "privagent/perceive-vision":
      return ok<VisionAnalysis>(await perceiveVision(message.regions, message.viewport));
    case "privagent/warm-vision":
      await warmVisionHost();
      return ok<{ warm: true }>({ warm: true });
    case "privagent/verify-names":
      return ok<boolean[][]>(await verifyNamesInHost(message.items));
    case "privagent/run-loop":
      // Deliberately not awaited: the loop outlives any sendMessage reply channel. The
      // popup polls "privagent/loop-result" for the terminal state.
      startTaskLoop(message.taskId, message.task);
      return ok<{ started: true }>({ started: true });
    case "privagent/loop-result":
      return ok<LoopResult | null>(loopResult(message.taskId));
    case "privagent/active-loop":
      return ok<{ taskId: string; task: string } | null>(activeLoop());
    case "privagent/sent-payloads":
      return ok<SanitizedContext[]>(sentPayloads(message.taskId));
    case "privagent/step-result":
      stashStepReport(message.taskId, message.step, message.report);
      return ok<{ stashed: true }>({ stashed: true });
    case "privagent/cancel-task":
      cancelTask(message.taskId);
      return ok<{ cancelled: true }>({ cancelled: true });
    default:
      return fail({ code: "execution_failed", message: "Unknown message type" });
  }
}

const HANDLED: ReadonlySet<string> = new Set([
  "privagent/reason",
  "privagent/audit",
  "privagent/read-audit",
  "privagent/run-task",
  "privagent/perceive-vision",
  "privagent/warm-vision",
  "privagent/verify-names",
  "privagent/run-loop",
  "privagent/loop-result",
  "privagent/active-loop",
  "privagent/sent-payloads",
  "privagent/step-result",
  "privagent/cancel-task",
]);

async function respond(request: ToBackground): Promise<Reply<unknown>> {
  try {
    return await handle(request);
  } catch (error) {
    const described = describeError(error);
    console.warn(`PrivAgent ${request.type} failed:`, described.message);
    return fail(described);
  }
}

/**
 * Only answers the message types this worker owns. `runtime.sendMessage` broadcasts to
 * every extension context, so replying to anything else would race the real recipient.
 */
browser.runtime.onMessage.addListener((message: unknown) => {
  const request = message as ToBackground;
  if (!HANDLED.has(request?.type)) return undefined;
  return respond(request);
});
