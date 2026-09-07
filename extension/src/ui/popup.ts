import browser from "webextension-polyfill";
import { DEFAULT_SERVER_URL, getServerUrl, setServerUrl } from "../shared/config";
import type { AuditEntry, LoopResult, Reply, TaskSummary, ToBackground } from "../shared/messages";

const form = document.querySelector<HTMLFormElement>("#task-form")!;
const taskInput = document.querySelector<HTMLInputElement>("#task")!;
const runButton = document.querySelector<HTMLButtonElement>("#run")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const multiStep = document.querySelector<HTMLInputElement>("#multi-step")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const summarySection = document.querySelector<HTMLElement>("#summary")!;
const summaryList = document.querySelector<HTMLDListElement>("#summary-list")!;
const traceSection = document.querySelector<HTMLElement>("#trace")!;
const traceList = document.querySelector<HTMLOListElement>("#trace-list")!;
const serverInput = document.querySelector<HTMLInputElement>("#server")!;
const saveServer = document.querySelector<HTMLButtonElement>("#save-server")!;
const detachButton = document.querySelector<HTMLButtonElement>("#detach")!;

async function send<T>(message: ToBackground): Promise<T> {
  const reply = (await browser.runtime.sendMessage(message)) as Reply<T>;
  if (!reply?.ok) throw new Error(reply?.error?.message ?? "No response from the extension");
  return reply.value;
}

/**
 * Updates the status line and records the run's state on the element itself.
 *
 * `data-state` exists because text alone is ambiguous to anything watching: after a
 * second run starts, "Task finished" is still on screen for a moment, and a reader - a
 * test, or a screen reader announcing changes - cannot tell a finished run from one that
 * has not visibly started. The state attribute changes exactly once per transition.
 */
function setStatus(message: string, state: "idle" | "running" | "done" | "error"): void {
  status.textContent = message;
  status.dataset.state = state;
  status.classList.toggle("error", state === "error");
}

function renderSummary(summary: TaskSummary): void {
  const rows: Array<[string, string]> = [
    ["Elements perceived", String(summary.observed)],
    ["Seen by vision", String(summary.perceivedByVision)],
    // Called out separately from the vision count: a face is the one thing here that is
    // PII on sight, and it is always withheld rather than described to the server.
    ["Faces detected (never sent)", String(summary.facesDetected)],
    ["Marks transmitted", String(summary.transmitted)],
    ["Elements redacted", String(summary.redactedElements)],
    ["Withheld for review", String(summary.withheldForReview)],
    ["Action", summary.action ? `${summary.action.action} (${summary.action.risk})` : "none"],
    ["Outcome", summary.outcome],
  ];

  summaryList.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }),
  );
  summarySection.hidden = false;
}

function renderTrace(entries: AuditEntry[]): void {
  traceList.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement("li");
      item.className = entry.ok ? "ok" : "bad";
      const stage = document.createElement("span");
      stage.className = "stage";
      stage.textContent = entry.stage;
      const detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = entry.detail;
      item.append(stage, detail);
      return item;
    }),
  );
  traceSection.hidden = entries.length === 0;
}

/**
 * How a finished loop reads to the person who asked for it. One line each; the trace
 * below carries the step-by-step detail.
 */
const LOOP_ENDINGS: Record<LoopResult["status"], string> = {
  done: "Task completed",
  blocked: "Stopped: this site blocks automation or needs you to act",
  declined: "Stopped: you denied a proposed action",
  cancelled: "Stopped by you",
  budget_exhausted: "Stopped: step limit reached before the task finished",
  no_progress: "Stopped: nothing useful left to do on this page",
  failed: "Failed",
};

/** Polls the audit trail while a loop runs, so the popup shows live per-step progress. */
function startProgress(taskId: string): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    void send<AuditEntry[]>({ type: "privagent/read-audit", taskId })
      .then((entries) => {
        // A poll in flight when the loop finishes must not overwrite the final status.
        if (stopped) return;
        const steps = entries.filter((entry) => entry.stage === "observe").length;
        if (steps > 0 && status.dataset.state === "running") {
          setStatus(`Running step ${steps}...`, "running");
        }
        renderTrace(entries);
      })
      .catch(() => undefined);
  }, 800);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Polls the background for the loop's terminal result.
 *
 * The alternative - awaiting the run-loop message itself - breaks on Chrome MV3: the
 * reply channel of a single sendMessage closes long before a multi-minute loop finishes
 * ("message channel closed before a response was received"). Pulling the result also
 * keeps the service worker alive: each poll is an extension message, which resets its
 * idle timer while the loop works.
 */
async function waitForLoopResult(taskId: string): Promise<LoopResult> {
  for (;;) {
    const result = await send<LoopResult | null>({ type: "privagent/loop-result", taskId });
    if (result) return result;
    await new Promise((done) => setTimeout(done, 800));
  }
}

async function runSingle(task: string): Promise<void> {
  const summary = await send<TaskSummary>({ type: "privagent/run-task", task });
  renderSummary(summary);
  renderTrace(await send<AuditEntry[]>({ type: "privagent/read-audit", taskId: summary.taskId }));
  status.dataset.taskId = summary.taskId;
  setStatus(`Task finished: ${summary.outcome}.`, "done");
}

/**
 * Follows a running loop to its terminal state and renders the outcome.
 *
 * Shared by two callers on purpose: a loop started from THIS popup, and a loop this
 * popup found already running when it opened (the previous popup died with a tab
 * switch - the loop, which lives in the background, did not). Both must render
 * identically or "re-attached" would look like a different, lesser mode.
 */
async function watchLoop(taskId: string): Promise<void> {
  status.dataset.taskId = taskId;
  stopButton.hidden = false;
  stopButton.disabled = false;
  const stopProgress = startProgress(taskId);

  try {
    const result = await waitForLoopResult(taskId);
    stopProgress();
    renderTrace(await send<AuditEntry[]>({ type: "privagent/read-audit", taskId }));
    setStatus(
      `${LOOP_ENDINGS[result.status]} after ${result.steps} step(s): ${result.detail}`,
      result.status === "done" ? "done" : result.status === "failed" ? "error" : "done",
    );
  } finally {
    stopProgress();
    stopButton.hidden = true;
  }
}

async function runLoop(task: string): Promise<void> {
  const taskId = crypto.randomUUID();
  await send<{ started: true }>({ type: "privagent/run-loop", taskId, task });
  await watchLoop(taskId);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = taskInput.value.trim();
  if (!task) return;

  runButton.disabled = true;
  setStatus("Perceiving the page locally...", "running");
  summarySection.hidden = true;
  traceSection.hidden = true;

  try {
    if (multiStep.checked) await runLoop(task);
    else await runSingle(task);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
    renderTrace(await send<AuditEntry[]>({ type: "privagent/read-audit" }).catch(() => []));
  } finally {
    runButton.disabled = false;
  }
});

stopButton.addEventListener("click", () => {
  const taskId = status.dataset.taskId;
  if (!taskId) return;
  stopButton.disabled = true;
  setStatus("Stopping after the current step...", "running");
  void send({ type: "privagent/cancel-task", taskId }).catch(() => undefined);
});

saveServer.addEventListener("click", async () => {
  await setServerUrl(serverInput.value.trim() || DEFAULT_SERVER_URL);
  setStatus("Reasoner URL saved.", "idle");
});

void getServerUrl().then((url) => {
  serverInput.value = url;
});

/**
 * Draft persistence: the browser closes a toolbar popup on ANY focus loss - switching
 * tabs, clicking the page, alt-tabbing - and takes the typed task with it. The draft is
 * saved on every keystroke and restored on open, so a closed popup costs nothing.
 * `storage.session` when the browser has it (cleared when the browser exits, which is
 * the right lifetime for a draft), `storage.local` otherwise. Only ever the user's own
 * typed task text - nothing observed from any page.
 */
interface DraftArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const drafts: DraftArea =
  (browser.storage as unknown as { session?: DraftArea }).session ?? browser.storage.local;
const DRAFT_KEY = "privagent/draft";

function saveDraft(): void {
  void drafts
    .set({ [DRAFT_KEY]: { task: taskInput.value, multiStep: multiStep.checked } })
    .catch(() => undefined);
}

async function restoreDraft(): Promise<void> {
  try {
    const stored = (await drafts.get(DRAFT_KEY))[DRAFT_KEY] as
      { task?: string; multiStep?: boolean } | undefined;
    if (stored?.task && !taskInput.value) taskInput.value = stored.task;
    if (typeof stored?.multiStep === "boolean") multiStep.checked = stored.multiStep;
  } catch {
    // A popup with an empty field is the worst case here, not an error worth surfacing.
  }
}

taskInput.addEventListener("input", saveDraft);
multiStep.addEventListener("change", saveDraft);

/**
 * "Keep open": reopens this same page as its own window, which the browser does NOT
 * close on focus loss - it stays until the user closes it. Hidden when this instance
 * already is that window.
 */
if (new URLSearchParams(location.search).has("detached")) {
  detachButton.hidden = true;
}
detachButton.addEventListener("click", () => {
  void browser.windows
    .create({
      url: browser.runtime.getURL("src/ui/popup.html") + "?detached=1",
      type: "popup",
      width: 460,
      height: 760,
    })
    .then(() => window.close())
    .catch(() => undefined);
});

/**
 * Re-attach on open: if a loop is already running, this popup adopts it - live progress,
 * working Stop button, final status - instead of showing "Ready." over an active agent.
 */
async function reattach(): Promise<void> {
  const active = await send<{ taskId: string; task: string } | null>({
    type: "privagent/active-loop",
  }).catch(() => null);
  if (!active) return;

  if (!taskInput.value) taskInput.value = active.task;
  multiStep.checked = true;
  runButton.disabled = true;
  setStatus("Re-attached to the running task...", "running");
  try {
    await watchLoop(active.taskId);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    runButton.disabled = false;
  }
}

void restoreDraft().then(reattach);

/**
 * Loads the local vision models while the user is still typing.
 *
 * The runtime, the detector and the OCR language data come to ~33 MB. Loaded inside the
 * first task, they make the first thing the user asks for by far the slowest thing the
 * agent ever does. Loaded here, the cost lands in the seconds between opening the popup
 * and pressing Run. Failure is silent on purpose: this is an optimisation, and the task
 * path reports vision problems itself.
 */
void send({ type: "privagent/warm-vision" }).catch(() => undefined);
