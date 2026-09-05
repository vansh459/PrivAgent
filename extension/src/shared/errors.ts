/**
 * Structured error types shared by the content script, background worker and UI.
 *
 * Every failure mode here was previously either an exception with an opaque message or,
 * worse, a silent empty result. `detectFaces()` returning `[]` when the browser had no
 * face-detection API is the exact pattern this module exists to prevent: a capability
 * that is absent must be reported as absent, never as "found nothing".
 */

export type PrivAgentErrorCode =
  | "capability_unavailable"
  | "model_unavailable"
  | "server_unreachable"
  | "server_rejected"
  | "invalid_response"
  | "execution_failed"
  | "cancelled_by_user";

export class PrivAgentError extends Error {
  readonly code: PrivAgentErrorCode;
  readonly detail: string | undefined;

  constructor(code: PrivAgentErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "PrivAgentError";
    this.code = code;
    this.detail = detail;
  }

  toJSON(): { code: PrivAgentErrorCode; message: string; detail?: string } {
    return {
      code: this.code,
      message: this.message,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

/**
 * A local capability the pipeline asked for is not present in this browser.
 *
 * Callers must surface this rather than degrading silently, so a missing model or API
 * shows up as a visible gap instead of an empty detection list.
 */
export class CapabilityUnavailableError extends PrivAgentError {
  readonly capability: string;

  constructor(capability: string, detail?: string) {
    super("capability_unavailable", `Local capability unavailable: ${capability}`, detail);
    this.name = "CapabilityUnavailableError";
    this.capability = capability;
  }
}

export function isPrivAgentError(value: unknown): value is PrivAgentError {
  return value instanceof PrivAgentError;
}

/** Normalizes any thrown value into a serializable shape for messaging and audit. */
export function describeError(error: unknown): { code: PrivAgentErrorCode; message: string } {
  if (isPrivAgentError(error)) return { code: error.code, message: error.message };
  return {
    code: "execution_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}
