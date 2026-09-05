import { describe, expect, it } from "vitest";
import {
  assertScreenState,
  isSanitizedContext,
  isScreenState,
  parseAction,
  SCREEN_STATE_SCHEMA_VERSION,
  type ScreenState,
} from "../src/schemas/screenState";

function stateFor(role: string, text: string): ScreenState {
  return {
    schema_version: SCREEN_STATE_SCHEMA_VERSION,
    elements: [
      { id: "dom_1", role, text, bbox: [10, 20, 100, 32], source: "dom", sensitive: false },
    ],
    task: "continue task",
    page_url_hash: "sha256:test",
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

  it.each([
    ["a malformed payload", { schema_version: "1.0" }],
    ["an unknown schema version", { ...stateFor("button", "x"), schema_version: "2.0" }],
    ["a camelCase payload from an older client", { ...stateFor("button", "x"), pageUrlHash: "x" }],
  ])("rejects %s", (_case, state) => {
    expect(isScreenState(state)).toBe(false);
    expect(() => assertScreenState(state)).toThrow(TypeError);
  });

  it("requires a confidence score on vision-sourced elements", () => {
    const state = stateFor("button", "x");
    state.elements[0] = { ...state.elements[0]!, source: "vision_ocr" };

    expect(isScreenState(state)).toBe(true);
    expect(state.elements[0]?.confidence).toBeUndefined();
  });
});

describe("sanitized context", () => {
  it("accepts a Set-of-Mark payload", () => {
    expect(
      isSanitizedContext({
        schema_version: "1.0",
        task: "click download",
        elements: [{ mark_id: "M1", role: "button", text: "Download", bbox: [0, 0, 1, 1] }],
      }),
    ).toBe(true);
  });

  it("rejects a mark id that is not Set-of-Mark shaped", () => {
    expect(
      isSanitizedContext({
        schema_version: "1.0",
        task: "click",
        elements: [{ mark_id: "button-3", role: "button", text: "x", bbox: [0, 0, 1, 1] }],
      }),
    ).toBe(false);
  });
});

describe("parseAction", () => {
  it("accepts a complete action", () => {
    const action = parseAction({
      action: "click",
      target_id: "M1",
      params: {},
      confidence: 0.9,
      risk: "low",
      explanation: "matched",
      reasoning_trace_id: "trace_1",
    });

    expect(action.target_id).toBe("M1");
  });

  it.each([
    [
      "a missing explanation",
      { action: "none", confidence: 0.5, risk: "low", reasoning_trace_id: "t" },
    ],
    [
      "an out-of-range confidence",
      { action: "none", confidence: 3, risk: "low", explanation: "x", reasoning_trace_id: "t" },
    ],
    [
      "an unknown action verb",
      { action: "delete", confidence: 0.5, risk: "low", explanation: "x", reasoning_trace_id: "t" },
    ],
    [
      "an unexpected extra field",
      {
        action: "none",
        confidence: 0.5,
        risk: "low",
        explanation: "x",
        reasoning_trace_id: "t",
        script: "alert(1)",
      },
    ],
  ])("rejects %s", (_case, payload) => {
    expect(() => parseAction(payload)).toThrow(TypeError);
  });
});
