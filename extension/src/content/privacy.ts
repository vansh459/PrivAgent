export type PiiType = "AADHAAR" | "PAN" | "PHONE" | "EMAIL" | "CARD" | "OTP";

export interface PiiMatch {
  type: PiiType;
  value: string;
  start: number;
  end: number;
  confidence: number;
}

const DETECTORS: ReadonlyArray<[PiiType, RegExp]> = [
  ["AADHAAR", /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g],
  ["PAN", /\b[A-Z]{5}\d{4}[A-Z]\b/g],
  ["EMAIL", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
  ["PHONE", /(?<!\w)(?:\+91[ -]?)?[6-9]\d{9}\b/g],
  ["CARD", /\b(?:\d[ -]?){13,19}\b/g],
  ["OTP", /\b(?:OTP|one[- ]time password)\s*(?:is|:)?\s*\d{4,8}\b/gi],
];

export function detectStructuredPii(text: string): PiiMatch[] {
  return DETECTORS.flatMap(([type, expression]) =>
    [...text.matchAll(expression)].map((match) => ({
      type,
      value: match[0],
      start: match.index!,
      end: match.index! + match[0].length,
      confidence: 1,
    })),
  ).sort((a, b) => a.start - b.start);
}

export class ClientTokenMap {
  private readonly values = new Map<string, string>();
  private readonly counts = new Map<PiiType, number>();

  redact(text: string): string {
    const matches = detectStructuredPii(text);
    return matches.reduceRight((result, match) => {
      const number = (this.counts.get(match.type) ?? 0) + 1;
      this.counts.set(match.type, number);
      const token = `[PII_${match.type}_${String(number).padStart(2, "0")}]`;
      this.values.set(token, match.value);
      return `${result.slice(0, match.start)}${token}${result.slice(match.end)}`;
    }, text);
  }

  resolve(token: string): string | undefined {
    return this.values.get(token);
  }
}

export type PrivacyDecision = "allow" | "mask" | "review";
export function privacyDecision(confidence: number): PrivacyDecision {
  return confidence >= 0.6 ? "mask" : confidence >= 0.4 ? "review" : "allow";
}
