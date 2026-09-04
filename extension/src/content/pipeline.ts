import { buildContext, type SanitizedContext } from "./contextBuilder";
import { ClientTokenMap } from "./privacy";
import type { ScreenStateElement } from "../schemas/screenState";

export interface PreparedContext {
  context: SanitizedContext;
  tokens: ClientTokenMap;
}

/** Applies local text redaction before producing the only payload eligible for `/reason`. */
export function prepareContext(task: string, elements: ScreenStateElement[]): PreparedContext {
  const tokens = new ClientTokenMap();
  const sanitized = elements.map((element) => ({ ...element, text: tokens.redact(element.text) }));
  return { context: buildContext(task, sanitized), tokens };
}
