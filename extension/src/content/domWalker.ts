import type { BoundingBox, ScreenStateElement } from "../schemas/screenState";

export type { BoundingBox } from "../schemas/screenState";

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "[role]",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Input types whose on-screen content is a credential or a one-time secret. These are
 * dropped during extraction rather than during redaction: extraction is where the value
 * would first be read, so excluding later would already be too late.
 */
const CREDENTIAL_INPUT_TYPES = new Set(["password", "hidden"]);

/** `autocomplete` tokens the HTML spec reserves for credentials and payment secrets. */
const CREDENTIAL_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
]);

/** True for any field whose value must never be read, let alone transmitted. */
export function isCredentialField(element: HTMLElement): boolean {
  const autocomplete = element.getAttribute("autocomplete")?.toLowerCase().trim();
  if (autocomplete && CREDENTIAL_AUTOCOMPLETE.has(autocomplete)) return true;
  if (element instanceof HTMLInputElement && CREDENTIAL_INPUT_TYPES.has(element.type)) return true;
  return element.getAttribute("data-privagent-sensitive") === "true";
}

function elementRole(element: HTMLElement): string {
  const explicitRole = element.getAttribute("role");
  if (explicitRole) return explicitRole;
  if (element instanceof HTMLInputElement) {
    return element.type === "checkbox" || element.type === "radio" ? element.type : "text_field";
  }
  const implicitRoles: Record<string, string> = {
    A: "link",
    BUTTON: "button",
    SELECT: "combobox",
    TEXTAREA: "text_field",
  };
  return implicitRoles[element.tagName] ?? "interactive";
}

/** Uses the form control's own label association, covering both `for=` and nesting. */
function labelTextFor(element: HTMLElement): string | undefined {
  const labels = (element as HTMLInputElement).labels;
  const label = labels?.[0] ?? element.closest("label");
  return label?.textContent?.trim() || undefined;
}

/**
 * Describes a field by its identity, never by its contents.
 *
 * `element.value` is deliberately never read. The reasoner needs to know that a field
 * exists and what it is for; whatever the user has typed into it is not ours to send.
 */
function elementText(element: HTMLElement): string {
  const ariaLabel = ariaLabelFor(element);
  if (ariaLabel) return ariaLabel;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return labelTextFor(element) || element.placeholder || element.name || "";
  }
  return element.innerText?.trim() || element.textContent?.trim() || "";
}

function ariaLabelFor(element: HTMLElement): string | undefined {
  return element.getAttribute("aria-label")?.trim() || undefined;
}

function elementBoundingBox(element: HTMLElement): BoundingBox {
  const { x, y, width, height } = element.getBoundingClientRect();
  return [Math.round(x), Math.round(y), Math.round(width), Math.round(height)];
}

/** Filters elements a sighted user could not act on, which the agent must not report. */
function isPerceivable(element: HTMLElement, bbox: BoundingBox): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  if (bbox[2] <= 0 || bbox[3] <= 0) return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  const style = view.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

export interface DomPerception {
  elements: ScreenStateElement[];
  /** Live node for each element id, so execution never relies on stale coordinates. */
  refs: Map<string, HTMLElement>;
}

/** Extract visible interactive DOM elements into the DOM portion of Screen State. */
export function walkInteractiveDom(root: ParentNode = document): ScreenStateElement[] {
  return perceiveDom(root).elements;
}

/** As `walkInteractiveDom`, but also returns the live nodes behind each element id. */
export function perceiveDom(root: ParentNode = document): DomPerception {
  const seen = new Set<HTMLElement>();
  const elements: ScreenStateElement[] = [];
  const refs = new Map<string, HTMLElement>();

  for (const element of root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)) {
    if (seen.has(element)) continue;
    seen.add(element);
    if (isCredentialField(element)) continue;

    const bbox = elementBoundingBox(element);
    if (!isPerceivable(element, bbox)) continue;

    const ariaLabel = ariaLabelFor(element);
    const id = `dom_${elements.length + 1}`;
    elements.push({
      id,
      role: elementRole(element),
      text: elementText(element),
      ...(ariaLabel ? { aria_label: ariaLabel } : {}),
      bbox,
      source: "dom",
      sensitive: false,
    });
    refs.set(id, element);
  }

  return { elements, refs };
}
