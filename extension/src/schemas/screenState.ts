/**
 * Client-side entry point for the wire contract.
 *
 * The types and validators are generated from `server/app/schemas.py` (see
 * `generated.ts`); this module only adds the ergonomic helpers the pipeline calls.
 */
import {
  ActionSchema,
  ScreenStateSchema,
  SanitizedContextSchema,
  type Action,
  type SanitizedContext,
  type ScreenState,
  type ScreenStateElement,
} from "./generated";

export type {
  Action,
  ContextElement,
  HistoryStep,
  SanitizedContext,
  ScreenState,
  ScreenStateElement,
  StepInfo,
} from "./generated";
export {
  ActionSchema,
  ContextElementSchema,
  SanitizedContextSchema,
  ScreenStateElementSchema,
  ScreenStateSchema,
} from "./generated";

export const SCREEN_STATE_SCHEMA_VERSION = "1.0" as const;

/** Viewport-relative `[x, y, width, height]` in CSS pixels. */
export type BoundingBox = ScreenStateElement["bbox"];

/** Which local perception stage produced an element. */
export type ElementSource = ScreenStateElement["source"];

/** Structured PII classes the Privacy Firewall can detect and tokenize. */
export type PiiType = NonNullable<ScreenStateElement["pii_type"]>;

export type ActionType = Action["action"];
export type RiskTier = Action["risk"];

export function isScreenState(value: unknown): value is ScreenState {
  return ScreenStateSchema.safeParse(value).success;
}

export function assertScreenState(value: unknown): asserts value is ScreenState {
  const result = ScreenStateSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError(`Invalid Screen State JSON: ${result.error.issues[0]?.message}`);
  }
}

export function isSanitizedContext(value: unknown): value is SanitizedContext {
  return SanitizedContextSchema.safeParse(value).success;
}

/** Parses a server response, rejecting anything that is not a schema-valid Action. */
export function parseAction(value: unknown): Action {
  const result = ActionSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError(`Invalid Action JSON: ${result.error.issues[0]?.message}`);
  }
  return result.data;
}
