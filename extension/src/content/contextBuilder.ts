import type { ContextElement, SanitizedContext, ScreenStateElement } from "../schemas/screenState";
import { SCREEN_STATE_SCHEMA_VERSION } from "../schemas/screenState";

export type { ContextElement, SanitizedContext } from "../schemas/screenState";

const ACTIONABLE_ROLES = new Set([
  "button",
  "link",
  "text_field",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
]);

/** Minimum-required-context rule: keep what the task could plausibly need, drop the rest. */
function relevant(element: ScreenStateElement, task: string): boolean {
  if (ACTIONABLE_ROLES.has(element.role)) return true;
  const terms = task.toLowerCase().split(/\W+/).filter(Boolean);
  return terms.some((term) => term.length > 2 && element.text.toLowerCase().includes(term));
}

/**
 * Builds the minimal server-bound payload from already-redacted client state.
 *
 * Elements still flagged `sensitive` are withheld entirely - either they are awaiting
 * user review, or the Privacy Firewall could not confidently clear them.
 */
export interface BuiltContext {
  context: SanitizedContext;
  /** Set-of-Mark id -> the Screen State element id it was derived from. */
  marks: Map<string, string>;
}

export function buildContext(task: string, elements: ScreenStateElement[]): BuiltContext {
  const kept: ContextElement[] = [];
  const marks = new Map<string, string>();

  for (const element of elements) {
    if (element.sensitive || !relevant(element, task)) continue;
    const markId = `M${kept.length + 1}`;
    marks.set(markId, element.id);
    kept.push({
      mark_id: markId,
      role: element.role,
      text: element.text,
      bbox: element.bbox,
    });
  }

  return { context: { schema_version: SCREEN_STATE_SCHEMA_VERSION, task, elements: kept }, marks };
}
