import { parseAction, SanitizedContextSchema } from "../schemas/screenState";
import type { Action, SanitizedContext } from "../schemas/screenState";
import { PrivAgentError } from "../shared/errors";

export interface ReasonOptions {
  serverUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Sends the sanitized context to the reasoner and validates what comes back.
 *
 * The outbound payload is re-validated here, at the last point before it leaves the
 * browser: this is the network boundary, so the check belongs here even though the
 * content script already built the payload from redacted state.
 */
export async function requestAction(
  context: SanitizedContext,
  { serverUrl, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: ReasonOptions,
): Promise<Action> {
  const outbound = SanitizedContextSchema.safeParse(context);
  if (!outbound.success) {
    throw new PrivAgentError(
      "invalid_response",
      "Refusing to transmit a context that does not match the sanitized schema",
      outbound.error.issues[0]?.message,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(`${serverUrl.replace(/\/$/, "")}/reason`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outbound.data),
      signal: controller.signal,
    });
  } catch (error) {
    throw new PrivAgentError(
      "server_unreachable",
      `Could not reach the reasoner at ${serverUrl}`,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new PrivAgentError(
      "server_rejected",
      `Reasoner returned HTTP ${response.status}`,
      await response.text().catch(() => undefined),
    );
  }

  try {
    return parseAction(await response.json());
  } catch (error) {
    throw new PrivAgentError(
      "invalid_response",
      "Reasoner returned a payload that is not a valid Action",
      error instanceof Error ? error.message : String(error),
    );
  }
}
