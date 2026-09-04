import { describe, expect, it } from "vitest";
import { buildContext } from "../src/content/contextBuilder";

describe("buildContext", () => {
  it("keeps actionable marks and excludes redacted content", () => {
    const output = buildContext("click download", [
      {
        id: "a",
        role: "button",
        text: "Download",
        bbox: [0, 0, 1, 1],
        source: "dom",
        sensitive: false,
      },
      {
        id: "b",
        role: "text",
        text: "[PII_EMAIL_01]",
        bbox: [0, 0, 1, 1],
        source: "vision",
        sensitive: true,
        confidence: 1,
      },
    ]);
    expect(output.elements).toEqual([
      { markId: "M1", role: "button", text: "Download", bbox: [0, 0, 1, 1] },
    ]);
    expect(JSON.stringify(output)).not.toContain("PII_EMAIL");
  });
});
