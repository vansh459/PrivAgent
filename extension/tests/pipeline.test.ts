import { describe, expect, it } from "vitest";
import { prepareContext } from "../src/content/pipeline";
import type { ScreenStateElement } from "../src/schemas/screenState";

function element(text: string, overrides: Partial<ScreenStateElement> = {}): ScreenStateElement {
  return {
    id: "dom_1",
    role: "button",
    text,
    bbox: [0, 0, 10, 10],
    source: "dom",
    sensitive: false,
    ...overrides,
  };
}

describe("client privacy pipeline", () => {
  it("does not put raw structured PII in the server-bound context", async () => {
    const { context, tokens } = await prepareContext("click continue", [
      element("Continue +91 9876543210"),
    ]);

    expect(JSON.stringify(context)).not.toContain("9876543210");
    expect(context.elements[0]?.text).toBe("Continue [PII_PHONE_01]");
    expect(tokens.resolve("[PII_PHONE_01]")).toBe("+91 9876543210");
  });

  it("labels the element with the PII class it contained", async () => {
    const { context } = await prepareContext("click", [element("Card 4111 1111 1111 1111")]);

    expect(context.elements[0]?.text).toBe("Card [PII_CARD_01]");
  });

  it("counts what it redacted so the audit trail can report it", async () => {
    const prepared = await prepareContext("click", [
      element("a@b.co", { id: "dom_1" }),
      element("nothing here", { id: "dom_2" }),
    ]);

    expect(prepared.redactedElements).toBe(1);
    expect(prepared.tokens.size).toBe(1);
  });

  it("shares one token map across elements so a repeated value keeps its identity", async () => {
    const { context } = await prepareContext("click", [
      element("a@b.co", { id: "dom_1" }),
      element("a@b.co", { id: "dom_2" }),
    ]);

    expect(context.elements.map((entry) => entry.text)).toEqual([
      "[PII_EMAIL_01]",
      "[PII_EMAIL_01]",
    ]);
  });
});
