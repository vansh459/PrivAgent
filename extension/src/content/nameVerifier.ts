import type * as ort from "onnxruntime-web";

/**
 * NER verification for rule-detected NAME candidates (hybrid precision layer).
 *
 * The rule-based name detector is tuned for recall - it finds every labelled name on the
 * 42-screen dataset - but two capitalized words are how English writes headlines, product
 * names and menu items too, and 133 of its distinct detections there were exactly that
 * ("Building Scalable APIs", "Dadra and Nagar Haveli"). This module keeps the rules as the
 * candidate generator and adds a small quantized token-classification model
 * (TinyBERT fine-tuned on CoNLL-2003, int8, 14.5 MB) that runs ONLY over those candidate
 * spans - dozens of short strings per page, not the page - and rejects a candidate the
 * model sees no person in.
 *
 * The decision rule and its threshold were chosen offline against every reviewed detection
 * in `tests/dataset/pii-review.json` (scripts/eval-ner-verifier.py): at threshold 0.02 the
 * model rejects 128/133 reviewed false positives while keeping 31/31 site-published real
 * names and all 42 labelled persona names. The threshold is deliberately tiny - a
 * candidate is kept masked if the model sees *any* person-signal in it, so the failure
 * direction of a borderline score is a redundant mask, never a leak. The lowest-scoring
 * genuine name measured 0.053, 2.6x the threshold.
 *
 * Verification only ever REMOVES redactions. Every error path - model missing, session
 * failure, malformed reply - must therefore be treated by callers as "candidate confirmed",
 * which returns the pipeline to its unverified (mask-everything) behaviour.
 */

/** One text with the rule-detected NAME candidate spans to verify, in char offsets. */
export interface NameVerifyItem {
  text: string;
  spans: { start: number; end: number }[];
}

/** Below this max-PER-token probability, a candidate is rejected as not-a-person. */
export const NAME_VERIFIER_THRESHOLD = 0.02;

/** Characters of context kept on each side of a candidate before encoding. */
export const NAME_VERIFIER_WINDOW = 200;

/**
 * B-PER / I-PER class indices in the model's output. The shipped model's config carries
 * unmapped `LABEL_*` names; probing with known sentences (see scripts/eval-ner-verifier.py)
 * shows it uses the standard CoNLL-2003 order: O, B-PER, I-PER, B-ORG, I-ORG, B-LOC,
 * I-LOC, B-MISC, I-MISC.
 */
const PER_LABEL_IDS = [1, 2] as const;

const CLS_ID = 101;
const SEP_ID = 102;
const UNK_TOKEN = "[UNK]";
const MAX_TOKENS = 512;
const MAX_WORD_CHARS = 100;

interface TokenizerJson {
  model: {
    vocab: Record<string, number>;
    continuing_subword_prefix?: string;
  };
}

interface NormalizedChar {
  ch: string;
  /** Span in the ORIGINAL string, so decisions map back to detector offsets. */
  start: number;
  end: number;
}

/** BERT's punctuation class: the four ASCII symbol runs plus Unicode category P. */
function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  ) {
    return true;
  }
  return /\p{P}/u.test(ch);
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || /\p{Zs}/u.test(ch);
}

function isControl(ch: string): boolean {
  if (ch === "\t" || ch === "\n" || ch === "\r") return false;
  return /[\p{Cc}\p{Cf}]/u.test(ch);
}

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  );
}

/**
 * Minimal WordPiece tokenizer matching the shipped `tokenizer.json` (bert-base-uncased
 * scheme: clean text, lowercase, strip accents, isolate punctuation and CJK, `##`
 * continuations, `[UNK]` fallback). Implemented here rather than pulling in a tokenizer
 * library because the extension needs exactly this one configuration, with character
 * offsets into the original string - the offsets are what let a PER token score be
 * attributed to the detector's candidate span.
 */
export class WordPieceTokenizer {
  private readonly vocab: Map<string, number>;
  private readonly prefix: string;

  constructor(vocab: Map<string, number>, continuingSubwordPrefix = "##") {
    this.vocab = vocab;
    this.prefix = continuingSubwordPrefix;
  }

  static fromTokenizerJson(json: unknown): WordPieceTokenizer {
    const parsed = json as TokenizerJson;
    if (!parsed?.model?.vocab) {
      throw new Error("tokenizer.json has no model.vocab; cannot build the name verifier");
    }
    return new WordPieceTokenizer(
      new Map(Object.entries(parsed.model.vocab)),
      parsed.model.continuing_subword_prefix ?? "##",
    );
  }

  /** Normalizes into a char array that remembers where each char came from. */
  private normalize(text: string): NormalizedChar[] {
    const out: NormalizedChar[] = [];
    let index = 0;
    for (const raw of text) {
      const start = index;
      index += raw.length;
      const cp = raw.codePointAt(0) ?? 0;
      if (cp === 0 || cp === 0xfffd || isControl(raw)) continue;
      if (isWhitespace(raw)) {
        out.push({ ch: " ", start, end: index });
        continue;
      }
      const cjk = isCjk(cp);
      if (cjk) out.push({ ch: " ", start, end: start });
      // Lowercase then strip combining marks; either step may change the char count, and
      // every resulting char keeps the original span so offsets stay in source coordinates.
      for (const piece of raw.toLowerCase().normalize("NFD")) {
        if (/\p{Mn}/u.test(piece)) continue;
        out.push({ ch: piece, start, end: index });
      }
      if (cjk) out.push({ ch: " ", start: index, end: index });
    }
    return out;
  }

  /** Whitespace-splits, isolates punctuation, then WordPiece-encodes each word. */
  encode(text: string): { ids: number[]; offsets: { start: number; end: number }[] } {
    const ids: number[] = [CLS_ID];
    const offsets: { start: number; end: number }[] = [{ start: 0, end: 0 }];

    const words: NormalizedChar[][] = [];
    let current: NormalizedChar[] = [];
    for (const item of this.normalize(text)) {
      if (item.ch === " ") {
        if (current.length > 0) words.push(current);
        current = [];
      } else if (isPunctuation(item.ch)) {
        if (current.length > 0) words.push(current);
        current = [];
        words.push([item]);
      } else {
        current.push(item);
      }
    }
    if (current.length > 0) words.push(current);

    const budget = MAX_TOKENS - 1; // room for the trailing [SEP]
    for (const word of words) {
      if (ids.length >= budget) break;
      for (const piece of this.wordPiece(word)) {
        if (ids.length >= budget) break;
        ids.push(piece.id);
        offsets.push({ start: piece.start, end: piece.end });
      }
    }

    ids.push(SEP_ID);
    offsets.push({ start: 0, end: 0 });
    return { ids, offsets };
  }

  private wordPiece(word: NormalizedChar[]): { id: number; start: number; end: number }[] {
    const unk = () => [
      {
        id: this.vocab.get(UNK_TOKEN) ?? 100,
        start: word[0]!.start,
        end: word[word.length - 1]!.end,
      },
    ];
    if (word.length > MAX_WORD_CHARS) return unk();

    const text = word.map((item) => item.ch).join("");
    const pieces: { id: number; start: number; end: number }[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let found: number | undefined;
      while (start < end) {
        const candidate = (start > 0 ? this.prefix : "") + text.slice(start, end);
        const id = this.vocab.get(candidate);
        if (id !== undefined) {
          found = id;
          break;
        }
        end -= 1;
      }
      // No subword matches at all: WordPiece marks the whole word unknown, not the suffix.
      if (found === undefined) return unk();
      pieces.push({ id: found, start: word[start]!.start, end: word[end - 1]!.end });
      start = end;
    }
    return pieces;
  }
}

/** The slice of `ort.InferenceSession` the verifier uses; injectable for tests. */
export interface NerSession {
  inputNames: readonly string[];
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, { data: unknown }>>;
}

export interface NameVerifierOptions {
  threshold?: number;
  window?: number;
}

/**
 * Scores rule-detected NAME candidates with the bundled token-classification model.
 *
 * One inference per candidate, over a +-200-char window around it. A candidate is
 * confirmed (stays masked) when any PER-class token overlapping its span reaches the
 * threshold; see the module comment for how that threshold was chosen and why its failure
 * direction is safe.
 */
export class NameVerifier {
  private readonly session: NerSession;
  private readonly tokenizer: WordPieceTokenizer;
  private readonly tensor: typeof ort.Tensor;
  private readonly threshold: number;
  private readonly window: number;

  constructor(
    session: NerSession,
    tokenizer: WordPieceTokenizer,
    tensor: typeof ort.Tensor,
    options: NameVerifierOptions = {},
  ) {
    this.session = session;
    this.tokenizer = tokenizer;
    this.tensor = tensor;
    this.threshold = options.threshold ?? NAME_VERIFIER_THRESHOLD;
    this.window = options.window ?? NAME_VERIFIER_WINDOW;
  }

  /** One boolean per span per item: true = confirmed as a person, keep the mask. */
  async verify(items: readonly NameVerifyItem[]): Promise<boolean[][]> {
    const results: boolean[][] = [];
    for (const item of items) {
      const confirmed: boolean[] = [];
      for (const span of item.spans) {
        confirmed.push((await this.scoreSpan(item.text, span)) >= this.threshold);
      }
      results.push(confirmed);
    }
    return results;
  }

  private async scoreSpan(text: string, span: { start: number; end: number }): Promise<number> {
    const lo = Math.max(0, span.start - this.window);
    const hi = Math.min(text.length, span.end + this.window);
    const { ids, offsets } = this.tokenizer.encode(text.slice(lo, hi));
    const relStart = span.start - lo;
    const relEnd = span.end - lo;

    const shape = [1, ids.length];
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new this.tensor("int64", BigInt64Array.from(ids, BigInt), shape),
      attention_mask: new this.tensor("int64", new BigInt64Array(ids.length).fill(1n), shape),
    };
    if (this.session.inputNames.includes("token_type_ids")) {
      feeds["token_type_ids"] = new this.tensor("int64", new BigInt64Array(ids.length), shape);
    }

    const output = await this.session.run(feeds);
    const logits = Object.values(output)[0]?.data as Float32Array;
    const classes = logits.length / ids.length;

    let best = 0;
    for (const [index, offset] of offsets.entries()) {
      if (offset.end <= offset.start) continue; // [CLS] / [SEP]
      if (offset.start >= relEnd || offset.end <= relStart) continue;
      const row = logits.subarray(index * classes, (index + 1) * classes);
      best = Math.max(best, perProbability(row));
    }
    return best;
  }
}

/**
 * Softmax over one token's logits, then the best PER-class probability. Max rather than
 * sum, to match exactly how the threshold was calibrated offline.
 */
function perProbability(logits: Float32Array): number {
  let max = -Infinity;
  for (const value of logits) max = Math.max(max, value);
  let sum = 0;
  const exps = new Float64Array(logits.length);
  for (const [index, value] of logits.entries()) {
    exps[index] = Math.exp(value - max);
    sum += exps[index]!;
  }
  let per = 0;
  for (const id of PER_LABEL_IDS) per = Math.max(per, (exps[id] ?? 0) / sum);
  return per;
}
