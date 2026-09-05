import browser from "webextension-polyfill";
import { DEFAULT_SERVER_URL, getServerUrl, setServerUrl } from "../shared/config";
import type { AuditEntry, Reply, TaskSummary, ToBackground } from "../shared/messages";

const form = document.querySelector<HTMLFormElement>("#task-form")!;
const taskInput = document.querySelector<HTMLInputElement>("#task")!;
const runButton = document.querySelector<HTMLButtonElement>("#run")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const summarySection = document.querySelector<HTMLElement>("#summary")!;
const summaryList = document.querySelector<HTMLDListElement>("#summary-list")!;
const traceSection = document.querySelector<HTMLElement>("#trace")!;
const traceList = document.querySelector<HTMLOListElement>("#trace-list")!;
const serverInput = document.querySelector<HTMLInputElement>("#server")!;
const saveServer = document.querySelector<HTMLButtonElement>("#save-server")!;

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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const task = taskInput.value.trim();
  if (!task) return;

  runButton.disabled = true;
  setStatus("Perceiving the page locally...", "running");
  summarySection.hidden = true;
  traceSection.hidden = true;

  try {
    const summary = await send<TaskSummary>({ type: "privagent/run-task", task });
    renderSummary(summary);
    renderTrace(await send<AuditEntry[]>({ type: "privagent/read-audit", taskId: summary.taskId }));
    status.dataset.taskId = summary.taskId;
    setStatus(`Task finished: ${summary.outcome}.`, "done");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
    renderTrace(await send<AuditEntry[]>({ type: "privagent/read-audit" }).catch(() => []));
  } finally {
    runButton.disabled = false;
  }
});

saveServer.addEventListener("click", async () => {
  await setServerUrl(serverInput.value.trim() || DEFAULT_SERVER_URL);
  setStatus("Reasoner URL saved.", "idle");
});

void getServerUrl().then((url) => {
  serverInput.value = url;
});

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
