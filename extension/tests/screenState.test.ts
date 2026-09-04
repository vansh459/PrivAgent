import { describe, expect, it } from "vitest";
import {
  assertScreenState,
  isScreenState,
  SCREEN_STATE_SCHEMA_VERSION,
  type ScreenState,
} from "../src/schemas/screenState";

function stateFor(role: string, text: string): ScreenState {
  return {
    schemaVersion: SCREEN_STATE_SCHEMA_VERSION,
    elements: [
      { id: "dom_1", role, text, bbox: [10, 20, 100, 32], source: "dom", sensitive: false },
    ],
    task: "continue task",
    pageUrlHash: "sha256:test",
    timestamp: "2026-09-04T10:00:00Z",
  };
}

describe("Screen State JSON schema", () => {
  it.each([
    ["form", stateFor("text_field", "Email")],
    ["dashboard", stateFor("button", "Refresh")],
    ["portal", stateFor("link", "Download report")],
    ["e-commerce", stateFor("button", "Add to cart")],
    ["single-page application", stateFor("menuitem", "Open navigation")],
  ])("validates a %s screen output", (_siteType, state) => {
    expect(isScreenState(state)).toBe(true);
    expect(() => assertScreenState(state)).not.toThrow();
  });

  it("rejects a malformed screen output", () => {
    expect(isScreenState({ ...stateFor("button", "Continue"), elements: [{ id: "dom_1" }] })).toBe(
      false,
    );
    expect(() => assertScreenState({ schemaVersion: SCREEN_STATE_SCHEMA_VERSION })).toThrow(
      "Invalid Screen State JSON",
    );
  });
});
