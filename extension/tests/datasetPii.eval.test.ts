import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPii, resolveSpans } from "../src/content/privacy";
import type { PiiType } from "../src/schemas/screenState";

/**
 * Build Spec Phase 8.3: PII recall and precision over the labelled dataset.
 *
 * This runs against text, offline, rather than in a browser, because detection is a
 * property of the string and putting a browser in the way would only add ways for the
 * number to be wrong. What the browser suite measures instead is Phase 8.4 - whether the
 * values that were detected actually stayed off the wire.
 *
 * The corpus is every string this project's DOM walker would be handed on all 42 screens:
 * 4 483 of them, of which 397 carry an injected value with a known type. The other 4 086
 * are whatever those real pages actually say - navigation in five scripts, tender numbers,
 * dates, prices, recovery-certificate ids - which is a far more hostile precision test than
 * a list of near-misses somebody wrote on purpose.
 *
 * Detections outside the labelled spans are **not** automatically false positives, and this
 * test does not treat them as such. Real government portals publish real helpline numbers,
 * real grievance-cell addresses and, in the income-tax portal's recovery notices, real
 * PANs; finding those is the system working. Every distinct one was read against the page
 * it came from and given a verdict in `tests/dataset/pii-review.json`, and precision is
 * computed from those verdicts rather than from an assumption.
 */

const datasetDir = resolve(import.meta.dirname, "..", "..", "tests", "dataset", "screens");
const reviewFile = resolve(import.meta.dirname, "..", "..", "tests", "dataset", "pii-review.json");
const resultsDir = resolve(import.meta.dirname, "..", "..", "test-results");

interface Screen {
  id: string;
  type: string;
  texts: { text: string; truthId: string | null }[];
  pii: { id: string; type: PiiType; value: string; text: string }[];
}

function screens(): Screen[] {
  return readdirSync(datasetDir)
    .filter((name) => name.endsWith(".json") && !["sources.json", "index.json"].includes(name))
    .sort()
    .map((name) => JSON.parse(readFileSync(resolve(datasetDir, name), "utf8")) as Screen);
}

/** True when a resolved span of the right type covers the labelled value. */
function coversValue(text: string, value: string, type: PiiType): boolean {
  const at = text.indexOf(value);
  return resolveSpans(detectPii(text)).some(
    (span) =>
      span.type === type &&
      // Overlap rather than exact bounds: "Aadhaar 4321 8765 2109" may be detected as the
      // twelve digits alone or with its separators, and both are correct redactions.
      span.start < at + value.length &&
      span.end > at,
  );
}

function write(name: string, value: unknown): void {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(resolve(resultsDir, name), JSON.stringify(value, null, 2) + "\n", "utf8");
}

describe("PII detection over the labelled dataset (Phase 8.3)", () => {
  const all = screens();

  it("recalls the injected spans, and reports what it misses by type", () => {
    const byType = new Map<string, { found: number; total: number; missed: string[] }>();
    let found = 0;
    let total = 0;
    let unperceived = 0;

    for (const screen of all) {
      const labelled = new Map(
        screen.texts.filter((row) => row.truthId).map((row) => [row.truthId, row.text]),
      );
      for (const span of screen.pii) {
        const text = labelled.get(span.id);
        if (text === undefined) {
          // The span was injected but its element was not perceivable, so the firewall was
          // never handed it. That is a perception result, not a detection one.
          unperceived += 1;
          continue;
        }
        total += 1;
        const bucket = byType.get(span.type) ?? { found: 0, total: 0, missed: [] };
        bucket.total += 1;
        if (coversValue(text, span.value, span.type)) {
          bucket.found += 1;
          found += 1;
        } else {
          bucket.missed.push(span.value);
        }
        byType.set(span.type, bucket);
      }
    }

    const rows = [...byType.entries()]
      .map(([type, bucket]) => ({
        type,
        recall: bucket.found / bucket.total,
        found: bucket.found,
        total: bucket.total,
        missedExamples: [...new Set(bucket.missed)].slice(0, 6),
      }))
      .sort((left, right) => left.recall - right.recall);

    write("dataset-pii.json", {
      screens: all.length,
      spans: total,
      found,
      recall: found / total,
      unperceived,
      byType: rows,
    });

    // eslint-disable-next-line no-console -- the measurement is the point of this test.
    console.log(
      `\nPII recall over ${all.length} screens: ${found}/${total} = ` +
        `${((100 * found) / total).toFixed(1)}%`,
    );

    // A floor, not the measured value: this asserts the pipeline has not regressed, and
    // docs/RESULTS.md carries what it actually scored.
    expect(total).toBeGreaterThanOrEqual(390);
    expect(found / total).toBeGreaterThan(0.95);
  });

  it("scores precision against the reviewed verdict for every unlabelled detection", () => {
    const review = JSON.parse(readFileSync(reviewFile, "utf8")) as {
      entries: { type: string; value: string; verdict: string }[];
    };
    const verdicts = new Map(
      review.entries.map((entry) => [`${entry.type}|${entry.value}`, entry.verdict]),
    );

    const unlabelled: { screen: string; type: string; value: string; text: string }[] = [];
    const unreviewed: string[] = [];
    const tally: Record<string, number> = { real: 0, wrong_type: 0, false_positive: 0 };
    let strings = 0;
    let labelledSpans = 0;

    for (const screen of all) {
      // A detection is only "unlabelled" if what it matched is not one of this screen's
      // injected values. The walker perceives container elements too - a nav wrapper's
      // innerText contains its children's - so the same injected number legitimately
      // appears in several strings, and counting each of those as a false positive would
      // be counting correct behaviour as failure.
      const injected = screen.pii.map((span) => span.value);
      const isInjected = (value: string) =>
        injected.some((known) => known.includes(value) || value.includes(known));

      for (const row of screen.texts) {
        if (row.truthId) {
          labelledSpans += 1;
          continue;
        }
        strings += 1;
        for (const span of resolveSpans(detectPii(row.text))) {
          const value = row.text.slice(span.start, span.end);
          if (isInjected(value)) continue;
          unlabelled.push({
            screen: screen.id,
            type: span.type,
            value,
            text: row.text.slice(0, 120),
          });
          const verdict = verdicts.get(`${span.type}|${value}`);
          if (verdict === undefined) unreviewed.push(`${span.type}|${value}`);
          else tally[verdict] = (tally[verdict] ?? 0) + 1;
        }
      }
    }

    write("pii-unlabelled.json", { strings, detections: unlabelled.length, rows: unlabelled });

    // Precision counts a detection as correct when it masked something that really is
    // personal data, whatever label it put on it - a landline masked as a card number is a
    // type error, not a leak. The type-correct figure is reported next to it.
    const truePositives = labelledSpans + tally.real + tally.wrong_type;
    const typeCorrect = labelledSpans + tally.real;
    const total = labelledSpans + unlabelled.length;
    const precision = truePositives / total;

    write("dataset-pii-precision.json", {
      strings: strings + labelledSpans,
      detections: total,
      labelledSpans,
      unlabelledDetections: unlabelled.length,
      ...tally,
      precision,
      typeCorrectPrecision: typeCorrect / total,
    });

    // eslint-disable-next-line no-console -- the measurement is the point of this test.
    console.log(
      `PII precision over ${strings + labelledSpans} strings: ${truePositives}/${total} = ` +
        `${(100 * precision).toFixed(1)}%  (${tally.real} real values published by the sites ` +
        `themselves, ${tally.false_positive} false positives)`,
    );

    // Every detection outside a labelled span must carry a reviewed verdict. Changing a
    // detector surfaces new values here, and the honest response is to read them and extend
    // tests/dataset/pii-review.json - not to widen a tolerance.
    expect(
      [...new Set(unreviewed)],
      "unreviewed detections; read them and add them to tests/dataset/pii-review.json",
    ).toEqual([]);
    expect(precision).toBeGreaterThan(0.6);
  });
});
