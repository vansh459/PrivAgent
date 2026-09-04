export type AgentAction = {
  action: "click" | "type" | "scroll" | "navigate" | "none";
  target_id?: string;
  params?: Record<string, string>;
  confidence: number;
};
export type RiskTier = "low" | "medium" | "high";

export function riskFor(action: AgentAction, sensitive = false): RiskTier {
  if (action.action === "navigate" || sensitive || action.confidence < 0.5) return "high";
  if (action.action === "type" || action.confidence < 0.75) return "medium";
  return "low";
}

export function executeAction(action: AgentAction, marks: Map<string, HTMLElement>): boolean {
  if (action.action === "none") return false;
  if (action.action === "navigate") {
    window.location.assign(action.params?.url ?? "");
    return true;
  }
  if (action.action === "scroll") {
    window.scrollBy({ top: Number(action.params?.top ?? 0), behavior: "smooth" });
    return true;
  }
  const target = action.target_id ? marks.get(action.target_id) : undefined;
  if (!target || !target.isConnected) return false;
  if (action.action === "click") {
    target.click();
    return true;
  }
  if (
    action.action === "type" &&
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
  ) {
    target.value = action.params?.text ?? "";
    target.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  return false;
}
