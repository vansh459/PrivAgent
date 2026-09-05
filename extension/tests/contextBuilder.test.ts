import { describe, expect, it } from "vitest";
import { buildContext } from "../src/content/contextBuilder";
import type { ScreenStateElement } from "../src/schemas/screenState";

function element(overrides: Partial<ScreenStateElement> = {}): ScreenStateElement {
  return {
    id: "dom_1",
    role: "button",
    text: "Download",
    bbox: [0, 0, 10, 10],
    source: "dom",
    sensitive: false,
    ...overrides,
  };
}

describe("buildContext", () => {
  it("keeps actionable marks and withholds anything still flagged sensitive", () => {
    const { context } = buildContext("click download", [
      element(),
      element({ id: "dom_2", role: "text", text: "[PII_EMAIL_01]", sensitive: true }),
    ]);

    expect(context.elements).toEqual([
      { mark_id: "M1", role: "button", text: "Download", bbox: [0, 0, 10, 10] },
    ]);
    expect(context.schema_version).toBe("1.0");
  });

  it("maps every mark back to the element it came from", () => {
    const { marks } = buildContext("click download", [
      element({ id: "dom_7" }),
      element({ id: "dom_9", role: "link", text: "Reports" }),
    ]);

    expect([...marks]).toEqual([
      ["M1", "dom_7"],
      ["M2", "dom_9"],
    ]);
  });

  it("drops fields unrelated to the task (minimum required context)", () => {
    const { context } = buildContext("download the report", [
      element({ id: "dom_1", role: "link", text: "Download report" }),
      element({ id: "dom_2", role: "text", text: "Unrelated marketing copy" }),
    ]);

    expect(context.elements.map((entry) => entry.text)).toEqual(["Download report"]);
  });

  it("numbers marks contiguously even when elements are withheld", () => {
    const { context } = buildContext("click", [
      element({ id: "dom_1", sensitive: true }),
      element({ id: "dom_2" }),
      element({ id: "dom_3" }),
    ]);

    expect(context.elements.map((entry) => entry.mark_id)).toEqual(["M1", "M2"]);
  });
});
