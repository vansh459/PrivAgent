// GENERATED FILE - DO NOT EDIT.
// Source of truth: server/app/schemas.py
// Regenerate with: npm run gen:schemas

import { z } from "zod";

/** The server's proposed next step, validated locally before execution. */
export interface Action {
  action: "click" | "type" | "scroll" | "navigate" | "none" | "done" | "blocked";
  confidence: number;
  explanation: string;
  params?: Record<string, string>;
  reasoning_trace_id: string;
  risk: "low" | "medium" | "high";
  target_id?: string | null;
}

export const ActionSchema: z.ZodType<Action> = z.strictObject({
  action: z.enum(["click", "type", "scroll", "navigate", "none", "done", "blocked"]),
  confidence: z.number().min(0).max(1),
  explanation: z.string().min(1),
  params: z.record(z.string(), z.string()).optional(),
  reasoning_trace_id: z.string().min(1),
  risk: z.enum(["low", "medium", "high"]),
  target_id: z.string().nullable().optional(),
});

/** A Set-of-Mark tagged element that is safe to transmit. */
export interface ContextElement {
  bbox: [number, number, number, number];
  mark_id: string;
  role: string;
  text: string;
}

export const ContextElementSchema: z.ZodType<ContextElement> = z.strictObject({
  bbox: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]),
  mark_id: z.string().regex(/^M\d+$/),
  role: z.string().min(1),
  text: z.string(),
});

/** One compact prior step, so the reasoner can plan without re-deriving the past.

`page_ident` is the page's *redacted title* - it has been through the same Privacy
Firewall as every element text. It is never a URL, not even hashed: URLs are on the
never-transmitted list in docs/SECURITY.md and stay there in 1.1. */
export interface HistoryStep {
  action: "click" | "type" | "scroll" | "navigate" | "none" | "done" | "blocked";
  outcome: string;
  page_ident: string;
  target_role?: string | null;
}

export const HistoryStepSchema: z.ZodType<HistoryStep> = z.strictObject({
  action: z.enum(["click", "type", "scroll", "navigate", "none", "done", "blocked"]),
  outcome: z.string().min(1).max(120),
  page_ident: z.string().max(120),
  target_role: z.string().nullable().optional(),
});

/** Where the multi-step loop is: step `n` of at most `limit`. */
export interface StepInfo {
  limit: number;
  n: number;
}

export const StepInfoSchema: z.ZodType<StepInfo> = z.strictObject({
  limit: z.number().int().min(1).max(50),
  n: z.number().int().min(1).max(50),
});

/** The only payload eligible to cross the network boundary. */
export interface SanitizedContext {
  elements: ContextElement[];
  history?: HistoryStep[];
  page_ident?: string | null;
  schema_version: "1.0" | "1.1";
  step?: StepInfo | null;
  task: string;
}

export const SanitizedContextSchema: z.ZodType<SanitizedContext> = z.strictObject({
  elements: z.array(ContextElementSchema),
  history: z.array(HistoryStepSchema).optional(),
  page_ident: z.string().max(120).nullable().optional(),
  schema_version: z.enum(["1.0", "1.1"]),
  step: StepInfoSchema.nullable().optional(),
  task: z.string().min(1).max(500),
});

/** One perceived on-screen element, before context building. */
export interface ScreenStateElement {
  aria_label?: string | null;
  bbox: [number, number, number, number];
  confidence?: number | null;
  id: string;
  pii_type?: "AADHAAR" | "PAN" | "PHONE" | "EMAIL" | "CARD" | "OTP" | "NAME" | "ADDRESS" | null;
  role: string;
  sensitive: boolean;
  source: "dom" | "vision_ocr" | "vision_face" | "vision_object";
  text: string;
}

export const ScreenStateElementSchema: z.ZodType<ScreenStateElement> = z.strictObject({
  aria_label: z.string().nullable().optional(),
  bbox: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]),
  confidence: z.number().min(0).max(1).nullable().optional(),
  id: z.string().min(1),
  pii_type: z.enum(["AADHAAR", "PAN", "PHONE", "EMAIL", "CARD", "OTP", "NAME", "ADDRESS"]).nullable().optional(),
  role: z.string().min(1),
  sensitive: z.boolean(),
  source: z.enum(["dom", "vision_ocr", "vision_face", "vision_object"]),
  text: z.string(),
});

/** The fused local view of the screen. Never transmitted; client-internal only. */
export interface ScreenState {
  elements: ScreenStateElement[];
  page_url_hash: string;
  schema_version: "1.0";
  task: string;
  timestamp: string;
}

export const ScreenStateSchema: z.ZodType<ScreenState> = z.strictObject({
  elements: z.array(ScreenStateElementSchema),
  page_url_hash: z.string().min(1),
  schema_version: z.literal("1.0"),
  task: z.string().min(1).max(500),
  timestamp: z.string().min(1),
});
