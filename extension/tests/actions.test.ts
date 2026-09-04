import { describe, expect, it, vi } from "vitest";
import { executeAction, riskFor } from "../src/content/actions";

describe("action validation and execution", () => {
  it("tiers unsafe actions locally", () => {
    expect(riskFor({ action: "click", confidence: 0.9 })).toBe("low");
    expect(riskFor({ action: "type", confidence: 0.9 })).toBe("medium");
    expect(riskFor({ action: "navigate", confidence: 0.9 })).toBe("high");
  });
  it("does not act on a stale mark", () =>
    expect(executeAction({ action: "click", target_id: "M1", confidence: 1 }, new Map())).toBe(
      false,
    ));
  it("clicks a live mark", () => {
    const button = document.createElement("button");
    const click = vi.spyOn(button, "click");
    document.body.append(button);
    expect(
      executeAction({ action: "click", target_id: "M1", confidence: 1 }, new Map([["M1", button]])),
    ).toBe(true);
    expect(click).toHaveBeenCalled();
  });
});
