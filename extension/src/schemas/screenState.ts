import type { BoundingBox, DomScreenElement } from "../content/domWalker";

export const SCREEN_STATE_SCHEMA_VERSION = "1.0";

export interface ScreenStateElement extends DomScreenElement {
  piiType?: string;
}

export interface ScreenState {
  schemaVersion: typeof SCREEN_STATE_SCHEMA_VERSION;
  elements: ScreenStateElement[];
  task: string;
  pageUrlHash: string;
  timestamp: string;
}

function isBoundingBox(value: unknown): value is BoundingBox {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  );
}

function isElement(value: unknown): value is ScreenStateElement {
  if (!value || typeof value !== "object") return false;
  const element = value as Record<string, unknown>;
  const optionalStringsValid = ["ariaLabel", "piiType"].every(
    (key) => element[key] === undefined || typeof element[key] === "string",
  );
  return (
    typeof element.id === "string" &&
    typeof element.role === "string" &&
    typeof element.text === "string" &&
    isBoundingBox(element.bbox) &&
    element.source === "dom" &&
    element.sensitive === false &&
    optionalStringsValid
  );
}

/** Returns true only for the versioned client Screen State payload accepted by the pipeline. */
export function isScreenState(value: unknown): value is ScreenState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    state.schemaVersion === SCREEN_STATE_SCHEMA_VERSION &&
    Array.isArray(state.elements) &&
    state.elements.every(isElement) &&
    typeof state.task === "string" &&
    typeof state.pageUrlHash === "string" &&
    !Number.isNaN(Date.parse(String(state.timestamp)))
  );
}

export function assertScreenState(value: unknown): asserts value is ScreenState {
  if (!isScreenState(value)) throw new TypeError("Invalid Screen State JSON");
}
