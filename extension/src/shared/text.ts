/**
 * Character-level agreement between two strings.
 *
 * OCR is scored by edit distance rather than exact match because a single misread glyph
 * should cost one character, not the whole sample - and because "≥85% character accuracy"
 * is only a meaningful bar if a near-miss is measured as a near-miss.
 */

/** Levenshtein distance, iterative with a single row of state. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j]! + 1, current[j - 1]! + 1);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Fraction of `expected` recovered in `actual`, clamped to [0, 1].
 *
 * Whitespace is normalized first: Tesseract's line breaks and double spaces are layout
 * artifacts of where the text sat in the image, not recognition errors, and counting them
 * would understate accuracy for reasons that have nothing to do with reading the glyphs.
 */
export function characterAccuracy(expected: string, actual: string): number {
  const target = normalizeWhitespace(expected);
  if (target.length === 0) return normalizeWhitespace(actual).length === 0 ? 1 : 0;
  const distance = editDistance(target, normalizeWhitespace(actual));
  return Math.max(0, 1 - distance / target.length);
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
