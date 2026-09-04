import { describe, expect, it } from "vitest";
import { ClientTokenMap, detectStructuredPii, privacyDecision } from "../src/content/privacy";

describe("Privacy Firewall", () => {
  it("detects and locally tokenizes structured values", () => {
    const map = new ClientTokenMap();
    const output = map.redact("PAN ABCDE1234F, email vaibh@example.com, phone +91 9876543210");
    expect(output).toBe("PAN [PII_PAN_01], email [PII_EMAIL_01], phone [PII_PHONE_01]");
    expect(map.resolve("[PII_PAN_01]")).toBe("ABCDE1234F");
    expect(detectStructuredPii(output)).toEqual([]);
  });
  it.each([
    [0.39, "allow"],
    [0.4, "review"],
    [0.6, "mask"],
  ] as const)("gates confidence %s as %s", (confidence, expected) =>
    expect(privacyDecision(confidence)).toBe(expected),
  );
});
