export type BoundingBox = readonly [number, number, number, number];

export interface DomScreenElement {
  id: string;
  role: string;
  text: string;
  ariaLabel?: string;
  bbox: BoundingBox;
  source: "dom";
  sensitive: false;
}

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

function elementText(element: HTMLElement): string {
  const ariaLabel = ariaLabelFor(element);
  if (ariaLabel) return ariaLabel;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value || element.placeholder || element.name || "";
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

/** Extract visible interactive DOM elements into the DOM portion of Screen State. */
export function walkInteractiveDom(root: ParentNode = document): DomScreenElement[] {
  const seen = new Set<HTMLElement>();
  const elements: DomScreenElement[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)) {
    if (seen.has(element) || element.hidden || element.getAttribute("aria-hidden") === "true")
      continue;
    seen.add(element);
    const ariaLabel = ariaLabelFor(element);
    elements.push({
      id: `dom_${elements.length + 1}`,
      role: elementRole(element),
      text: elementText(element),
      ...(ariaLabel ? { ariaLabel } : {}),
      bbox: elementBoundingBox(element),
      source: "dom",
      sensitive: false,
    });
  }
  return elements;
}
