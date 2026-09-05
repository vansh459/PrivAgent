import { describe, expect, it } from "vitest";
import { detectUnstructuredPii } from "../src/content/unstructuredPii";
import { ClientTokenMap, privacyDecision } from "../src/content/privacy";
import { prepareContext } from "../src/content/pipeline";
import type { ScreenStateElement } from "../src/schemas/screenState";

/**
 * Phase 3.5's criterion, measured: on a 20-sample borderline set, nothing scoring between
 * 0.4 and 0.6 is silently passed through.
 *
 * This set could not be built until Phase 3.2 existed. Every earlier detector was a
 * regex - it either matched or it did not, and it scored 1.0 or 0.7 - so the review band
 * was implemented, wired and unit-tested against synthetic numbers, but no real detection
 * had ever landed in it. These twenty samples are real detections from the unstructured
 * recogniser: names with no label and no known given name, and address fragments carrying
 * one signal instead of two. They are exactly the cases where a confident answer would be
 * a guess.
 *
 * "Flagged, not silently passed through" is checked at three levels: the decision is
 * `review`, the value is tokenized rather than left in the text, and the element carrying
 * it is withheld from the payload entirely rather than transmitted with a token.
 */

/** Twenty texts whose only detection is a borderline one. */
const BORDERLINE = [
  "Contact Vikrant Bhardwaj about the file",
  "Forwarded by Tanmay Chakraborty",
  "Reviewed with Ishaan Mukherjee",
  "Prepared by Rudra Bhattacharya",
  "Assigned to Kaveri Subramanian",
  "Escalated by Mrinal Chatterjee",
  "Verified with Devika Ranganathan",
  "Handled by Aparajita Sengupta",
  "Signed off by Yohannes Tesfaye",
  "Noted by Chidinma Okonkwo",
  "Filed under Sipho Ndlovu",
  "Reviewed by Bilal Chaudhry",
  "Passed to Oluwaseun Adeyemi",
  "Countersigned by Nadia Haddad",
  "Second approver Kiet Nguyen",
  "Building 7, Fourth Floor",
  "Second Floor, East Block",
  "Near the main gate",
  "Tower B, Ninth Floor",
  "Opposite the district office",
] as const;

function borderlineMatches(text: string) {
  return detectUnstructuredPii(text).filter(
    (match) => match.confidence >= 0.4 && match.confidence < 0.6,
  );
}

function element(text: string): ScreenStateElement {
  return {
    id: "dom_1",
    role: "note",
    text,
    bbox: [0, 0, 200, 40],
    source: "dom",
    sensitive: false,
  };
}

describe("the confidence review band", () => {
  it("flags all twenty borderline samples instead of passing them through", () => {
    expect(BORDERLINE).toHaveLength(20);
    const passedThrough: string[] = [];

    for (const text of BORDERLINE) {
      const matches = borderlineMatches(text);
      if (matches.length === 0) {
        passedThrough.push(`${text} -> no borderline detection`);
        continue;
      }
      for (const match of matches) {
        if (privacyDecision(match.confidence) !== "review") {
          passedThrough.push(`${text} -> ${match.confidence}`);
        }
      }
    }

    expect(passedThrough, "borderline samples that were not flagged").toEqual([]);
  });

  it("tokenizes a borderline value rather than leaving it in the text", () => {
    for (const text of BORDERLINE) {
      const result = new ClientTokenMap().redact(text);

      expect(result.requiresReview, `${text} was not marked for review`).toBe(true);
      expect(result.text, `${text} kept its raw value`).not.toBe(text);
      expect(result.text).toMatch(/\[PII_(NAME|ADDRESS)_\d\d\]/);
    }
  });

  it("withholds the element entirely, so a borderline guess never reaches the server", () => {
    for (const text of BORDERLINE) {
      const prepared = prepareContext("review the note", [element(text)]);

      expect(prepared.withheldForReview, `${text} was not withheld`).toBe(1);
      expect(prepared.context.elements, `${text} reached the payload`).toEqual([]);
      expect(JSON.stringify(prepared.context)).not.toContain(text.split(" ").at(-1));
    }
  });

  it("keeps the band's boundaries where the thresholds say they are", () => {
    expect(privacyDecision(0.39)).toBe("allow");
    expect(privacyDecision(0.4)).toBe("review");
    expect(privacyDecision(0.59)).toBe("review");
    expect(privacyDecision(0.6)).toBe("mask");
  });

  it("does not flag a high-confidence detection for review", () => {
    // The band is for uncertainty, not for everything. A labelled name is masked and
    // transmitted as a token, which keeps the element usable to the agent.
    const prepared = prepareContext("call the account holder", [
      element("Account holder: Anita Sharma"),
    ]);

    expect(prepared.withheldForReview).toBe(0);
    expect(prepared.redactedElements).toBe(1);
    expect(JSON.stringify(prepared.context)).toContain("[PII_NAME_01]");
    expect(JSON.stringify(prepared.context)).not.toContain("Anita");
  });
});
