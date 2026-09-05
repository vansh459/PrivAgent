import { describe, expect, it } from "vitest";
import { ClientTokenMap, detectStructuredPii } from "../src/content/privacy";
import type { PiiType } from "../src/schemas/screenState";

/**
 * Build Spec Phase 3.1 acceptance criteria, as an executable test:
 * 100% detection across 30 structured PII samples, and 0 false positives across 30
 * non-PII controls.
 *
 * The controls matter as much as the positives. Most of them are near-misses chosen to
 * sit just outside a detector's boundary - an 11-digit number, a PAN with the wrong
 * letter/digit shape, an invoice reference that looks like a card - because that is where
 * a regex-based firewall actually loses precision.
 */

const POSITIVES: ReadonlyArray<readonly [PiiType, string]> = [
  ["AADHAAR", "1234 5678 9012"],
  ["AADHAAR", "1234-5678-9012"],
  ["AADHAAR", "123456789012"],
  ["AADHAAR", "Aadhaar no. 9876 5432 1098"],
  ["AADHAAR", "UID 4321 8765 2109 verified"],
  ["PAN", "ABCDE1234F"],
  ["PAN", "PAN: ZYXWV9876A"],
  ["PAN", "Permanent Account Number AAAPZ1234C"],
  ["PAN", "quote BNZAA2318J on the form"],
  ["PAN", "AAACR5055K"],
  ["PHONE", "9876543210"],
  ["PHONE", "+91 9876543210"],
  ["PHONE", "+91-8765432109"],
  ["PHONE", "call 7654321098 today"],
  ["PHONE", "6543210987"],
  ["EMAIL", "user@example.com"],
  ["EMAIL", "first.last@sub.domain.co.in"],
  ["EMAIL", "accounts+billing@example.org"],
  ["EMAIL", "Contact: help_desk@isro.gov.in"],
  ["EMAIL", "UPPER.CASE@EXAMPLE.COM"],
  ["CARD", "4111 1111 1111 1111"],
  ["CARD", "4111111111111111"],
  ["CARD", "5500-0000-0000-0004"],
  ["CARD", "card ending 3400 0000 0000 009"],
  ["CARD", "6011 0000 0000 0004"],
  ["OTP", "OTP is 123456"],
  ["OTP", "OTP: 4821"],
  ["OTP", "one-time password 99887766"],
  ["OTP", "Your OTP 5678 expires soon"],
  ["OTP", "one time password is 246810"],
];

const CONTROLS: readonly string[] = [
  "Download the quarterly expenditure report",
  "Submit application",
  "Reference number ABC123",
  "Order 12345",
  "Version 2.10.4 released",
  "Invoice INV-2026-0417",
  "Total: 1,24,500.00",
  "Meeting at 10:30 on 04/09/2026",
  "Building 7, Fourth Floor",
  "ISRO Satellite Centre, Bengaluru",
  "Press Ctrl+Shift+P to continue",
  "ABCDEF1234G",
  "ABCD1234E",
  "1234 5678 901",
  "12345678901",
  "0123456789",
  "5555555555",
  "1234-5678",
  "sanctioned-expenditure-2026",
  "user@localhost",
  "@example",
  "name at example dot com",
  "https://example.com/reports?id=88",
  "Chapter 12, Section 3456",
  "PIN 560037",
  "GSTIN placeholder field",
  "Status: approved on 2026-09-04",
  "Row 4 of 12 selected",
  "temperature 36.6 degrees",
  "The password field is required",
];

describe("Phase 3.1 - structured PII detection corpus", () => {
  it.each(POSITIVES)("detects %s in %s", (type, sample) => {
    const matches = detectStructuredPii(sample);

    expect(matches.length, `no detection in ${sample}`).toBeGreaterThan(0);
    expect(matches.map((match) => match.type)).toContain(type);
  });

  it.each(CONTROLS)("does not flag the control %s", (sample) => {
    expect(detectStructuredPii(sample)).toEqual([]);
  });

  it("achieves 100% recall over the positive corpus", () => {
    const missed = POSITIVES.filter(([, sample]) => detectStructuredPii(sample).length === 0);

    expect(missed).toEqual([]);
  });

  it("achieves zero false positives over the control corpus", () => {
    const flagged = CONTROLS.filter((sample) => detectStructuredPii(sample).length > 0);

    expect(flagged).toEqual([]);
  });

  it("leaves no raw value behind after redacting every positive sample", () => {
    const map = new ClientTokenMap();

    for (const [, sample] of POSITIVES) {
      const { text } = map.redact(sample);
      expect(detectStructuredPii(text), `residual PII in ${sample} -> ${text}`).toEqual([]);
    }
  });

  it("leaves every control sample byte-identical, except the one that is half an address", () => {
    const map = new ClientTokenMap();

    // "Building 7, Fourth Floor" is a near-miss control for the *structured* detectors,
    // and they still ignore it (asserted above). The unstructured recogniser added in
    // Phase 3.2 does claim it, with one weak signal, which puts it in the review band -
    // the element is withheld from the payload rather than transmitted. That is the
    // intended behaviour for a location fragment, and it is called out here rather than
    // quietly excluded from the corpus.
    const partialAddress = "Building 7, Fourth Floor";

    for (const sample of CONTROLS) {
      if (sample === partialAddress) continue;
      expect(map.redact(sample).text, sample).toBe(sample);
    }

    const flagged = map.redact(partialAddress);
    expect(flagged.requiresReview, "a weak address hit must be reviewed, not masked silently").toBe(
      true,
    );
  });
});
