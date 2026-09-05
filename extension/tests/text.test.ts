import { describe, expect, it } from "vitest";
import { characterAccuracy, editDistance, normalizeWhitespace } from "../src/shared/text";

describe("editDistance", () => {
  it.each([
    ["", "", 0],
    ["abc", "abc", 0],
    ["abc", "", 3],
    ["", "abc", 3],
    ["kitten", "sitting", 3],
    ["Invoice 2026", "lnvoice 2026", 1],
  ])("distance(%s, %s) = %i", (a, b, expected) => {
    expect(editDistance(a, b)).toBe(expected);
  });
});

describe("characterAccuracy", () => {
  it("scores an exact read as 1", () => {
    expect(characterAccuracy("Download Report", "Download Report")).toBe(1);
  });

  it("charges one character per misread glyph, not the whole sample", () => {
    // 15 characters, one substitution.
    expect(characterAccuracy("Download Report", "Downlood Report")).toBeCloseTo(14 / 15, 5);
  });

  it("ignores line breaks and runs of spaces, which are layout, not recognition", () => {
    expect(characterAccuracy("Total due 1200", "Total  due\n1200\n")).toBe(1);
  });

  it("never returns a negative score, however wrong the read", () => {
    expect(characterAccuracy("hi", "a completely different string")).toBe(0);
  });

  it("treats an empty expectation as satisfied only by empty output", () => {
    expect(characterAccuracy("", "")).toBe(1);
    expect(characterAccuracy("", "noise")).toBe(0);
  });
});

describe("normalizeWhitespace", () => {
  it("collapses and trims", () => {
    expect(normalizeWhitespace("  a \n b  ")).toBe("a b");
  });
});
