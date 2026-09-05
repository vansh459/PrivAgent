import type { Action, ActionType, RiskTier } from "../schemas/screenState";

export type { Action, ActionType, RiskTier } from "../schemas/screenState";

const RISK_ORDER: readonly RiskTier[] = ["low", "medium", "high"];

/** The higher of two tiers. Used so a server response can never lower local risk. */
export function maxRisk(left: RiskTier, right: RiskTier): RiskTier {
  return RISK_ORDER.indexOf(left) >= RISK_ORDER.indexOf(right) ? left : right;
}

/** Risk as judged locally, from action type, target sensitivity and model confidence. */
export function localRiskFor(
  action: Pick<Action, "action" | "confidence">,
  targetSensitive = false,
): RiskTier {
  // Doing nothing cannot be risky. The reasoner returns `none` with confidence 0 when it
  // finds no safe match, and the confidence rule below would then score that no-op as
  // high risk and put a confirmation prompt in front of the user - asking them to approve
  // an action that does not exist. Observed: a task sat waiting on that prompt until
  // something else dismissed it. Prompting on no-ops is also how prompts stop being read.
  if (action.action === "none") return "low";
  if (action.action === "navigate" || targetSensitive || action.confidence < 0.5) return "high";
  if (action.action === "type" || action.confidence < 0.75) return "medium";
  return "low";
}

/**
 * The tier the confirmation gate actually uses.
 *
 * The server proposes a risk tier, but it only ever sees redacted context, so it cannot
 * know whether a target is locally sensitive. We take the stricter of the two views: the
 * server can escalate risk, never reduce it.
 */
export function effectiveRisk(action: Action, targetSensitive = false): RiskTier {
  return maxRisk(action.risk, localRiskFor(action, targetSensitive));
}

/** Risk tiers that must not auto-execute without explicit user confirmation. */
export function requiresConfirmation(risk: RiskTier): boolean {
  return risk !== "low";
}

export type ExecutionOutcome =
  | { status: "executed"; action: ActionType }
  | { status: "skipped"; reason: "no_action" }
  | { status: "failed"; reason: ExecutionFailure; detail: string };

export type ExecutionFailure =
  "stale_target" | "unsupported_target" | "missing_parameter" | "blocked_navigation";

/**
 * Executes a validated action against live DOM references.
 *
 * Targets are always resolved through the mark map rather than through server-supplied
 * coordinates, so a page that changed since perception fails loudly as `stale_target`
 * instead of clicking whatever now occupies that position.
 */
export function executeAction(
  action: Action,
  marks: ReadonlyMap<string, HTMLElement>,
): ExecutionOutcome {
  if (action.action === "none") return { status: "skipped", reason: "no_action" };

  if (action.action === "navigate") {
    const url = action.params?.url;
    if (!url) {
      return { status: "failed", reason: "missing_parameter", detail: "navigate needs params.url" };
    }
    window.location.assign(url);
    return { status: "executed", action: "navigate" };
  }

  if (action.action === "scroll") {
    window.scrollBy({ top: Number(action.params?.top ?? 0), behavior: "smooth" });
    return { status: "executed", action: "scroll" };
  }

  const target = action.target_id ? marks.get(action.target_id) : undefined;
  if (!target || !target.isConnected) {
    return {
      status: "failed",
      reason: "stale_target",
      detail: `mark ${action.target_id ?? "<none>"} is no longer on the page`,
    };
  }

  if (action.action === "click") {
    target.click();
    return { status: "executed", action: "click" };
  }

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const text = action.params?.text;
    if (text === undefined) {
      return { status: "failed", reason: "missing_parameter", detail: "type needs params.text" };
    }
    target.value = text;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    return { status: "executed", action: "type" };
  }

  return {
    status: "failed",
    reason: "unsupported_target",
    detail: `cannot type into <${target.tagName.toLowerCase()}>`,
  };
}
