import { detectUnstructuredPii } from "./unstructuredPii";
import type { PiiType } from "../schemas/screenState";

export type { PiiType } from "../schemas/screenState";

export interface PiiMatch {
  type: PiiType;
  value: string;
  start: number;
  end: number;
  confidence: number;
}

/**
 * A resolved detection with the matched value deliberately omitted.
 *
 * `RedactionResult` flows onward into the pipeline, the audit trail and the popup, so it
 * must be safe to serialize anywhere. Raw values stay inside `ClientTokenMap`.
 */
export interface RedactedSpan {
  type: PiiType;
  start: number;
  end: number;
  confidence: number;
}

export interface RedactionResult {
  /** The input with every resolved span replaced by a stable `[PII_<TYPE>_<N>]` token. */
  text: string;
  /** Resolved, non-overlapping spans in reading order, without their values. */
  matches: RedactedSpan[];
  /** True when at least one match landed in the review band and was not auto-masked. */
  requiresReview: boolean;
}

interface Detector {
  type: PiiType;
  pattern: RegExp;
  /** Optional check that turns a pattern hit into a calibrated confidence score. */
  score?: (value: string) => number;
}

/** Luhn checksum, used to tell a real card number from an arbitrary digit run. */
export function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Ordered by specificity. When two detectors claim spans of identical length, the one
 * declared first wins, so `CARD` is not mislabelled as `AADHAAR`.
 */
const DETECTORS: readonly Detector[] = [
  { type: "OTP", pattern: /\b(?:OTP|one[- ]time password)\s*(?:is|:)?\s*\d{4,8}\b/gi },
  { type: "EMAIL", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  {
    type: "CARD",
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    // A failed checksum still gets masked, just with lower confidence - never reduce
    // recall on payment data to gain precision.
    score: (value) => (passesLuhn(value) ? 1 : 0.7),
  },
  { type: "AADHAAR", pattern: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g },
  { type: "PAN", pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { type: "PHONE", pattern: /(?<!\w)(?:\+91[ -]?)?[6-9]\d{9}\b/g },
];

interface RankedMatch {
  match: PiiMatch;
  priority: number;
}

function byReadingOrder(left: RankedMatch, right: RankedMatch): number {
  if (left.match.start !== right.match.start) return left.match.start - right.match.start;
  const leftLength = left.match.end - left.match.start;
  const rightLength = right.match.end - right.match.start;
  if (leftLength !== rightLength) return rightLength - leftLength;
  return left.priority - right.priority;
}

/** Every pattern hit, in reading order. Spans may overlap; see `resolveSpans`. */
export function detectStructuredPii(text: string): PiiMatch[] {
  return DETECTORS.flatMap((detector, priority) =>
    [...text.matchAll(detector.pattern)].map((hit) => ({
      priority,
      match: {
        type: detector.type,
        value: hit[0],
        start: hit.index,
        end: hit.index + hit[0].length,
        confidence: detector.score?.(hit[0]) ?? 1,
      },
    })),
  )
    .sort(byReadingOrder)
    .map((ranked) => ranked.match);
}

/**
 * Every detection, structured and unstructured, in reading order.
 *
 * The two families are merged before span resolution rather than applied in sequence: a
 * name and a phone number can overlap in text like "Anita 9876543210", and resolving them
 * together is what stops one detector from tokenizing inside the other's span and
 * corrupting both.
 */
export function detectPii(text: string): PiiMatch[] {
  return [...detectStructuredPii(text), ...detectUnstructuredPii(text)].sort(
    (left, right) =>
      left.start - right.start ||
      right.end - right.start - (left.end - left.start) ||
      right.confidence - left.confidence,
  );
}

/**
 * Reduces possibly-overlapping matches to a non-overlapping list, longest-match-wins,
 * scanning left to right.
 *
 * Without this, a card number matches both `CARD` and `AADHAAR`, and replacing both
 * corrupts the surrounding text and mislabels the type.
 */
export function resolveSpans(matches: PiiMatch[]): PiiMatch[] {
  const resolved: PiiMatch[] = [];
  let cursor = -1;
  for (const match of matches) {
    if (match.start < cursor) continue;
    resolved.push(match);
    cursor = match.end;
  }
  return resolved;
}

export type PrivacyDecision = "allow" | "mask" | "review";

/** Borderline detections are surfaced for review rather than silently passed through. */
export function privacyDecision(confidence: number): PrivacyDecision {
  return confidence >= 0.6 ? "mask" : confidence >= 0.4 ? "review" : "allow";
}

/**
 * Maps detected values to stable placeholder tokens. The reverse map is held only in
 * client memory and is never serialized - see `docs/SECURITY.md`.
 */
export class ClientTokenMap {
  private readonly valuesByToken = new Map<string, string>();
  private readonly tokensByValue = new Map<string, string>();
  private readonly counts = new Map<PiiType, number>();

  /** Replaces resolved spans with tokens, walking forward so indices stay valid. */
  redact(text: string): RedactionResult {
    const matches = resolveSpans(detectPii(text));
    const spans: RedactedSpan[] = [];
    let output = "";
    let cursor = 0;
    let requiresReview = false;

    for (const match of matches) {
      spans.push({
        type: match.type,
        start: match.start,
        end: match.end,
        confidence: match.confidence,
      });
      output += text.slice(cursor, match.start);
      const decision = privacyDecision(match.confidence);
      if (decision === "allow") {
        output += match.value;
      } else {
        if (decision === "review") requiresReview = true;
        output += this.tokenFor(match);
      }
      cursor = match.end;
    }

    return { text: output + text.slice(cursor), matches: spans, requiresReview };
  }

  /** Identical values reuse one token, so the server sees a consistent identity. */
  private tokenFor(match: PiiMatch): string {
    const key = `${match.type}:${match.value}`;
    const existing = this.tokensByValue.get(key);
    if (existing) return existing;

    const number = (this.counts.get(match.type) ?? 0) + 1;
    this.counts.set(match.type, number);
    const token = `[PII_${match.type}_${String(number).padStart(2, "0")}]`;
    this.tokensByValue.set(key, token);
    this.valuesByToken.set(token, match.value);
    return token;
  }

  resolve(token: string): string | undefined {
    return this.valuesByToken.get(token);
  }

  get size(): number {
    return this.valuesByToken.size;
  }
}
