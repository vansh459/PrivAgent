import { describe, expect, it, vi } from "vitest";
import {
  effectiveRisk,
  executeAction,
  localRiskFor,
  maxRisk,
  requiresConfirmation,
} from "../src/content/actions";
import type { Action } from "../src/schemas/screenState";

function action(overrides: Partial<Action> = {}): Action {
  return {
    action: "click",
    target_id: "M1",
    params: {},
    confidence: 0.9,
    risk: "low",
    explanation: "because",
    reasoning_trace_id: "trace_1",
    ...overrides,
  };
}

/**
 * Build Spec Phase 6.1 acceptance criteria: 15 labelled sample actions across all three
 * tiers, scored consistently. The mix is deliberate - the same verb appears at different
 * confidences and target sensitivities, so the table catches a scorer that keys off the
 * verb alone.
 */
const RISK_SAMPLES = [
  ["click a high-confidence button", "click", 0.95, false, "low"],
  ["click a confident link", "click", 0.8, false, "low"],
  ["scroll with high confidence", "scroll", 0.99, false, "low"],
  ["take no action", "none", 0.9, false, "low"],
  ["scroll at the confidence boundary", "scroll", 0.75, false, "low"],
  ["type into an ordinary field", "type", 0.95, false, "medium"],
  ["type with moderate confidence", "type", 0.8, false, "medium"],
  ["click just below the confidence bar", "click", 0.74, false, "medium"],
  ["click with middling confidence", "click", 0.6, false, "medium"],
  ["scroll with middling confidence", "scroll", 0.55, false, "medium"],
  ["navigate, however confident", "navigate", 0.99, false, "high"],
  ["navigate with low confidence", "navigate", 0.3, false, "high"],
  ["click a sensitive target", "click", 0.95, true, "high"],
  ["type into a sensitive target", "type", 0.95, true, "high"],
  ["click with very low confidence", "click", 0.2, false, "high"],
] as const;

describe("local risk scoring", () => {
  it.each(RISK_SAMPLES)("scores %s as %s risk", (_label, kind, confidence, sensitive, expected) => {
    expect(localRiskFor({ action: kind, confidence }, sensitive)).toBe(expected);
  });

  it("covers all three tiers across the sample set", () => {
    const tiers = new Set(RISK_SAMPLES.map(([, , , , expected]) => expected));

    expect([...tiers].sort()).toEqual(["high", "low", "medium"]);
    expect(RISK_SAMPLES).toHaveLength(15);
  });

  it("never auto-executes anything but low risk", () => {
    const autoExecuted = RISK_SAMPLES.filter(
      ([, kind, confidence, sensitive]) =>
        !requiresConfirmation(localRiskFor({ action: kind, confidence }, sensitive)),
    );

    expect(autoExecuted.every(([, , , , expected]) => expected === "low")).toBe(true);
  });

  it("never lets the server lower the local risk tier", () => {
    expect(effectiveRisk(action({ risk: "low", action: "navigate" }))).toBe("high");
    expect(effectiveRisk(action({ risk: "high" }))).toBe("high");
    expect(maxRisk("low", "medium")).toBe("medium");
  });

  it("requires confirmation for anything above low risk", () => {
    expect(requiresConfirmation("low")).toBe(false);
    expect(requiresConfirmation("medium")).toBe(true);
    expect(requiresConfirmation("high")).toBe(true);
  });
});

describe("no-op actions", () => {
  it("never asks the user to confirm doing nothing", () => {
    // The reasoner returns `none` with confidence 0 when it finds no safe match. Scored
    // by confidence alone that is "high risk", and the user is shown a prompt asking them
    // to approve an action that does not exist - which blocks the task until they answer
    // a question about nothing.
    const nothing = { action: "none", confidence: 0 } as const;

    expect(localRiskFor(nothing)).toBe("low");
    expect(requiresConfirmation(localRiskFor(nothing))).toBe(false);
  });

  it("still refuses to let a server escalate a no-op into an execution", () => {
    // The tier can only go up. A server calling `none` "high" is respected; it just means
    // the no-op is confirmed before being skipped, which is harmless.
    expect(
      effectiveRisk({
        action: "none",
        target_id: null,
        params: {},
        confidence: 0,
        risk: "high",
        explanation: "x",
        reasoning_trace_id: "t",
      }),
    ).toBe("high");
  });
});

describe("executeAction", () => {
  it("reports a stale mark instead of acting on the wrong element", () => {
    expect(executeAction(action(), new Map())).toEqual({
      status: "failed",
      reason: "stale_target",
      detail: "mark M1 is no longer on the page",
    });
  });

  it("clicks a live mark", () => {
    const button = document.createElement("button");
    const click = vi.spyOn(button, "click");
    document.body.append(button);

    expect(executeAction(action(), new Map([["M1", button]]))).toEqual({
      status: "executed",
      action: "click",
    });
    expect(click).toHaveBeenCalled();
  });

  it("types into a field and notifies listeners", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const onInput = vi.fn();
    input.addEventListener("input", onInput);

    const outcome = executeAction(
      action({ action: "type", params: { text: "hello" } }),
      new Map([["M1", input]]),
    );

    expect(outcome).toEqual({ status: "executed", action: "type" });
    expect(input.value).toBe("hello");
    expect(onInput).toHaveBeenCalled();
  });

  it("refuses to type into an element that has no value", () => {
    const div = document.createElement("div");
    document.body.append(div);

    expect(
      executeAction(action({ action: "type", params: { text: "x" } }), new Map([["M1", div]])),
    ).toMatchObject({ status: "failed", reason: "unsupported_target" });
  });

  it("rejects a navigate with no URL rather than navigating to nowhere", () => {
    expect(executeAction(action({ action: "navigate", target_id: null }), new Map())).toMatchObject(
      { status: "failed", reason: "missing_parameter" },
    );
  });

  it("skips a none action", () => {
    expect(executeAction(action({ action: "none", target_id: null }), new Map())).toEqual({
      status: "skipped",
      reason: "no_action",
    });
  });
});
