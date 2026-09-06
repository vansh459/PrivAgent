import type { NameVerifyItem } from "../content/nameVerifier";
import type { Action, HistoryStep, SanitizedContext, StepInfo } from "../schemas/screenState";
import type { Viewport, VisualRegion } from "../vision/analyze";
import type { PrivAgentErrorCode } from "./errors";

/** Ordered pipeline stages recorded in the audit trail (Build Spec Phase 7.1). */
export const AUDIT_STAGES = [
  "observe",
  "detect_pii",
  "redact",
  "reason",
  "validate",
  "act",
] as const;

export type AuditStage = (typeof AUDIT_STAGES)[number];

export interface AuditEntryInput {
  taskId: string;
  stage: AuditStage;
  /** Privacy-safe summary only. Callers must never pass raw values or PII. */
  detail: string;
  ok: boolean;
}

export interface AuditEntry extends AuditEntryInput {
  id: string;
  timestamp: string;
  /** Assigned by the audit store; insertion order, which timestamps cannot guarantee. */
  seq?: number;
}

/** Content script or popup -> background service worker. */
export type ToBackground =
  | { type: "privagent/reason"; taskId: string; context: SanitizedContext }
  | { type: "privagent/audit"; entry: AuditEntryInput }
  | { type: "privagent/read-audit"; taskId?: string }
  | { type: "privagent/run-task"; task: string }
  | { type: "privagent/perceive-vision"; regions: VisualRegion[]; viewport: Viewport }
  | { type: "privagent/warm-vision" }
  // Raw candidate texts travel one hop to the extension-origin vision host and no
  // further; only per-span booleans come back. Same trust boundary as the screenshot.
  | { type: "privagent/verify-names"; items: NameVerifyItem[] }
  // The popup mints the taskId so it can poll progress and cancel while the loop runs.
  | { type: "privagent/run-loop"; taskId: string; task: string }
  // Polled by the popup until non-null. A loop runs for minutes; Chrome closes a single
  // long-held sendMessage reply channel well before that, so completion is pulled, not
  // pushed - and each poll conveniently resets the service worker's idle timer.
  | { type: "privagent/loop-result"; taskId: string }
  // Fired by the content script the instant a step's action has executed, before any
  // further await. When the action navigates, the page - and with it the step's reply
  // channel - dies mid-step; this out-of-band copy is the report that survives.
  | { type: "privagent/step-result"; taskId: string; step: number; report: StepReport }
  | { type: "privagent/cancel-task"; taskId: string };

/** Background service worker -> content script. */
export type ToContent =
  | { type: "privagent/execute-task"; taskId: string; task: string }
  | {
      type: "privagent/loop-step";
      taskId: string;
      task: string;
      step: StepInfo;
      history: HistoryStep[];
    };

/**
 * What one loop step reports back to the controller. Everything here is already
 * privacy-safe: `pageIdent` is the page title AFTER redaction, outcomes are status
 * strings, and no element text or value rides along.
 */
export interface StepReport {
  state: "executed" | "done" | "blocked" | "declined" | "none" | "failed";
  actionType: Action["action"];
  targetRole: string | null;
  outcome: string;
  pageIdent: string;
  /** Set when the terminal state is `blocked`. */
  blockedReason?: string;
  /** The single-step summary, so the popup can render per-step counters. */
  summary: TaskSummary;
}

/** The loop controller's final answer for a whole multi-step task. */
export interface LoopResult {
  taskId: string;
  status:
    "done" | "blocked" | "declined" | "budget_exhausted" | "cancelled" | "failed" | "no_progress";
  steps: number;
  detail: string;
  history: HistoryStep[];
}

/**
 * Background service worker -> the offscreen document that hosts local vision.
 *
 * The screenshot travels this hop and no further: the offscreen document returns text,
 * boxes and counts, and the image is released when the pass returns.
 */
export type ToOffscreen =
  | {
      type: "privagent/vision-run";
      dataUrl: string;
      regions: VisualRegion[];
      viewport: Viewport;
    }
  | { type: "privagent/vision-warm" }
  // Distinct from the content script's "privagent/verify-names": `runtime.sendMessage`
  // broadcasts, so reusing one type string would have background and offscreen racing to
  // answer the same message.
  | { type: "privagent/verify-names-run"; items: NameVerifyItem[] };

export type { VisionAnalysis } from "../vision/analyze";

export type Reply<T> = { ok: true; value: T } | { ok: false; error: ErrorPayload };

export interface ErrorPayload {
  code: PrivAgentErrorCode;
  message: string;
}

export interface TaskSummary {
  taskId: string;
  task: string;
  observed: number;
  /** Elements contributed by the local vision pass (OCR text and detected faces). */
  perceivedByVision: number;
  /** Face regions detected on screen. Always withheld, never transmitted. */
  facesDetected: number;
  transmitted: number;
  redactedElements: number;
  withheldForReview: number;
  action: Action | null;
  outcome: string;
}

export function ok<T>(value: T): Reply<T> {
  return { ok: true, value };
}

export function fail<T>(error: ErrorPayload): Reply<T> {
  return { ok: false, error };
}
