import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ort from "onnxruntime-web";
import { beforeAll, describe, expect, it } from "vitest";
import { NameVerifier, WordPieceTokenizer, type NameVerifyItem } from "../src/content/nameVerifier";
import { prepareContext } from "../src/content/pipeline";
import { createVisionSession } from "../src/content/visionRuntime";
import type { ScreenStateElement } from "../src/schemas/screenState";

/**
 * The NER name verifier: the tokenizer against the shipped tokenizer.json, the model
 * against the shipped int8 ONNX file, and the pipeline against the one property that
 * must survive every failure mode - verification only ever REMOVES redactions.
 */

const assets = resolve(import.meta.dirname, "..", "assets", "models");
const tokenizerJson = JSON.parse(
  readFileSync(resolve(assets, "tinybert_ner_tokenizer.json"), "utf8"),
) as unknown;

describe("WordPiece tokenizer", () => {
  const tokenizer = WordPieceTokenizer.fromTokenizerJson(tokenizerJson);
  const vocab = new Map<string, number>(
    Object.entries((tokenizerJson as { model: { vocab: Record<string, number> } }).model.vocab),
  );

  it("wraps every encoding in [CLS] ... [SEP]", () => {
    const { ids } = tokenizer.encode("hello");
    expect(ids[0]).toBe(vocab.get("[CLS]"));
    expect(ids[ids.length - 1]).toBe(vocab.get("[SEP]"));
    expect(ids[1]).toBe(vocab.get("hello"));
  });

  it("lowercases and isolates punctuation, keeping offsets in the original string", () => {
    const text = "Hello, World!";
    const { ids, offsets } = tokenizer.encode(text);
    expect(ids).toEqual([
      vocab.get("[CLS]"),
      vocab.get("hello"),
      vocab.get(","),
      vocab.get("world"),
      vocab.get("!"),
      vocab.get("[SEP]"),
    ]);
    // The "world" token must point back at the capitalized original.
    expect(text.slice(offsets[3]!.start, offsets[3]!.end)).toBe("World");
  });

  it("splits an out-of-vocabulary word into ## continuations over the same span", () => {
    const text = "Ramesh";
    const { ids, offsets } = tokenizer.encode(text);
    const inner = ids.slice(1, -1);
    expect(inner.length).toBeGreaterThan(1);
    expect(offsets[1]!.start).toBe(0);
    expect(offsets[inner.length]!.end).toBe(text.length);
  });

  it("strips accents so José finds the same vocab entry as jose", () => {
    const accented = tokenizer.encode("José");
    const plain = tokenizer.encode("jose");
    expect(accented.ids).toEqual(plain.ids);
  });
});

describe("name verifier against the shipped model", () => {
  let verifier: NameVerifier;

  beforeAll(async () => {
    const model = new Uint8Array(readFileSync(resolve(assets, "tinybert_ner_int8.onnx")));
    const { session } = await createVisionSession(model, { backend: "wasm" });
    verifier = new NameVerifier(
      session,
      WordPieceTokenizer.fromTokenizerJson(tokenizerJson),
      ort.Tensor,
    );
  }, 60_000);

  function spanOf(text: string, value: string): NameVerifyItem {
    const at = text.indexOf(value);
    expect(at).toBeGreaterThanOrEqual(0);
    return { text, spans: [{ start: at, end: at + value.length }] };
  }

  it("confirms genuine names, in and out of context", async () => {
    const items = [
      spanOf("Account holder: Priya Nair, verified today", "Priya Nair"),
      spanOf(
        "Shri Shirish Chandra Murmu, Deputy Governor, spoke at the summit",
        "Shirish Chandra Murmu",
      ),
      spanOf("Neha Aggarwal", "Neha Aggarwal"),
    ];
    expect(await verifier.verify(items)).toEqual([[true], [true], [true]]);
  }, 60_000);

  it("rejects the headline-shaped false positives the rules cannot tell apart", async () => {
    // Verbatim rule detections from the 42-screen dataset, each reviewed as a false
    // positive and scoring ~0.0006 offline - more than an order of magnitude below the
    // threshold, so this test does not sit on the decision boundary.
    const items = [
      spanOf("Submit Information on Tax Evasion or Benami Property", "Tax Evasion"),
      spanOf("FAQs for Annual Filing Forms", "Annual Filing Forms"),
      spanOf("Quick apply Fixed Deposit", "Fixed Deposit"),
    ];
    expect(await verifier.verify(items)).toEqual([[false], [false], [false]]);
  }, 60_000);
});

describe("pipeline behaviour around the verifier", () => {
  function element(text: string, id = "dom_1"): ScreenStateElement {
    return { id, role: "button", text, bbox: [0, 0, 10, 10], source: "dom", sensitive: false };
  }

  it("releases a rejected name candidate but keeps structured PII masked", async () => {
    // "Annual Filing Forms" is a shape-only NAME hit in the review band, which today
    // withholds the whole element. A rejection must both keep the raw text and stop the
    // withholding - while the phone number in the sibling element stays tokenized.
    const prepared = await prepareContext(
      "click",
      [
        element("FAQs for Annual Filing Forms", "dom_1"),
        element("Request callback on 9876543210", "dom_2"),
      ],
      { verifyNames: async (items) => items.map((item) => item.spans.map(() => false)) },
    );
    const payload = JSON.stringify(prepared.context);
    expect(payload).toContain("Annual Filing Forms");
    expect(payload).toContain("[PII_PHONE_01]");
    expect(payload).not.toContain("9876543210");
    expect(prepared.namesRejected).toBe(1);
    expect(prepared.withheldForReview).toBe(0);
  });

  it("keeps every mask when the verifier throws (fail closed)", async () => {
    const prepared = await prepareContext("click", [element("Account holder: Anita Sharma")], {
      verifyNames: async () => {
        throw new Error("host unreachable");
      },
    });
    expect(JSON.stringify(prepared.context)).not.toContain("Anita");
    expect(prepared.namesRejected).toBe(0);
  });

  it("keeps every mask when the verifier returns a malformed reply", async () => {
    const prepared = await prepareContext("click", [element("Account holder: Anita Sharma")], {
      verifyNames: async () => [],
    });
    expect(JSON.stringify(prepared.context)).not.toContain("Anita");
  });

  it("keeps every mask when no verifier is provided", async () => {
    const prepared = await prepareContext("click", [element("Account holder: Anita Sharma")]);
    expect(JSON.stringify(prepared.context)).not.toContain("Anita");
  });
});
