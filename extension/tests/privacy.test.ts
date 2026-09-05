import { describe, expect, it } from "vitest";
import {
  ClientTokenMap,
  detectStructuredPii,
  passesLuhn,
  privacyDecision,
  resolveSpans,
} from "../src/content/privacy";

/**
 * The overlapping-span cases below are the regression suite for a confirmed defect: the
 * previous implementation applied overlapping matches with stale indices, which ate
 * surrounding text and labelled card numbers as Aadhaar numbers. Each case here failed
 * before the fix.
 */
describe("overlapping PII spans", () => {
  it.each([
    [
      "an email that contains a phone-shaped local part",
      "Contact 9876543210@example.com now",
      "Contact [PII_EMAIL_01] now",
      ["EMAIL"],
    ],
    [
      "an Aadhaar number beside a card number",
      "Aadhaar 1234 5678 9012 and card 4111 1111 1111 1111",
      "Aadhaar [PII_AADHAAR_01] and card [PII_CARD_01]",
      ["AADHAAR", "CARD"],
    ],
    [
      "a PAN beside a card number",
      "PAN ABCDE1234F card 5500 0000 0000 0004",
      "PAN [PII_PAN_01] card [PII_CARD_01]",
      ["PAN", "CARD"],
    ],
    [
      "a card number whose leading digits also look like an Aadhaar number",
      "Card 1234 5678 9012 3456 on file",
      "Card [PII_CARD_01] on file",
      ["CARD"],
    ],
    [
      "an OTP beside a phone number",
      "OTP is 123456 sent to 9876543210",
      "[PII_OTP_01] sent to [PII_PHONE_01]",
      ["OTP", "PHONE"],
    ],
  ])("redacts %s without corrupting surrounding text", (_case, input, expected, types) => {
    const result = new ClientTokenMap().redact(input);

    expect(result.text).toBe(expected);
    expect(result.matches.map((match) => match.type)).toEqual(types);
    expect(detectStructuredPii(result.text)).toEqual([]);
  });

  it("resolves overlaps longest-match-first, left to right", () => {
    const resolved = resolveSpans(detectStructuredPii("Card 1234 5678 9012 3456 on file"));

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.type).toBe("CARD");
  });

  it("numbers tokens in reading order", () => {
    const result = new ClientTokenMap().redact("first a@b.co then c@d.co");

    expect(result.text).toBe("first [PII_EMAIL_01] then [PII_EMAIL_02]");
  });

  it("gives one token to repeated occurrences of the same value", () => {
    const map = new ClientTokenMap();
    const result = map.redact("a@b.co and again a@b.co");

    expect(result.text).toBe("[PII_EMAIL_01] and again [PII_EMAIL_01]");
    expect(map.size).toBe(1);
  });
});

describe("detector calibration", () => {
  it("scores a Luhn-valid card higher than an arbitrary digit run", () => {
    const valid = detectStructuredPii("4111 1111 1111 1111")[0];
    const invalid = detectStructuredPii("1234 5678 9012 3456")[0];

    expect(valid?.confidence).toBe(1);
    expect(invalid?.confidence).toBe(0.7);
  });

  it("masks a Luhn-invalid card anyway, rather than trading recall for precision", () => {
    expect(privacyDecision(0.7)).toBe("mask");
    expect(new ClientTokenMap().redact("1234 5678 9012 3456").text).toBe("[PII_CARD_01]");
  });

  it.each([
    ["4111111111111111", true],
    ["5500 0000 0000 0004", true],
    ["1234567890123456", false],
  ])("validates the Luhn checksum of %s", (value, expected) =>
    expect(passesLuhn(value)).toBe(expected),
  );

  it.each([
    [0.39, "allow"],
    [0.4, "review"],
    [0.6, "mask"],
  ] as const)("gates confidence %s as %s", (confidence, expected) =>
    expect(privacyDecision(confidence)).toBe(expected),
  );
});

describe("client token map", () => {
  it("keeps the reverse mapping on the client only", () => {
    const map = new ClientTokenMap();
    const result = map.redact("PAN ABCDE1234F");

    expect(map.resolve("[PII_PAN_01]")).toBe("ABCDE1234F");
    expect(JSON.stringify(result)).not.toContain("ABCDE1234F");
  });

  it("leaves text with no detections untouched", () => {
    const result = new ClientTokenMap().redact("Download the quarterly report");

    expect(result.text).toBe("Download the quarterly report");
    expect(result.matches).toEqual([]);
    expect(result.requiresReview).toBe(false);
  });
});
