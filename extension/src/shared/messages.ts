import type { Action, SanitizedContext } from "../schemas/screenState";
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
  | { type: "privagent/warm-vision" };

/** Background service worker -> content script. */
export type ToContent = { type: "privagent/execute-task"; taskId: string; task: string };

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
  | { type: "privagent/vision-warm" };

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
