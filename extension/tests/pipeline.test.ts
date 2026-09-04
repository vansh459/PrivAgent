import { describe, expect, it } from "vitest";
import { prepareContext } from "../src/content/pipeline";

describe("client privacy pipeline", () => {
  it("does not put raw structured PII in server-bound context", () => {
    const { context, tokens } = prepareContext("click continue", [
      {
        id: "a",
        role: "button",
        text: "Continue +91 9876543210",
        bbox: [0, 0, 1, 1],
        source: "dom",
        sensitive: false,
      },
    ]);
    expect(JSON.stringify(context)).not.toContain("9876543210");
    expect(tokens.resolve("[PII_PHONE_01]")).toBe("+91 9876543210");
  });
});
