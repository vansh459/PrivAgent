import type { ScreenStateElement } from "../schemas/screenState";

export interface ContextElement {
  markId: string;
  role: string;
  text: string;
  bbox: readonly [number, number, number, number];
}
export interface SanitizedContext {
  schemaVersion: "1.0";
  task: string;
  elements: ContextElement[];
}

const ACTIONABLE_ROLES = new Set([
  "button",
  "link",
  "text_field",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
]);

function relevant(element: ScreenStateElement, task: string): boolean {
  if (ACTIONABLE_ROLES.has(element.role)) return true;
  const terms = task.toLowerCase().split(/\W+/).filter(Boolean);
  return terms.some((term) => term.length > 2 && element.text.toLowerCase().includes(term));
}

/** Builds the minimal server-bound payload from already-redacted client state. */
export function buildContext(task: string, elements: ScreenStateElement[]): SanitizedContext {
  return {
    schemaVersion: "1.0",
    task,
    elements: elements
      .filter((element) => !element.sensitive && relevant(element, task))
      .map((element, index) => ({
        markId: `M${index + 1}`,
        role: element.role,
        text: element.text,
        bbox: element.bbox,
      })),
  };
}
