import { buildContext } from "./contextBuilder";
import type { NameVerifyItem } from "./nameVerifier";
import { ClientTokenMap, detectPii } from "./privacy";
import type {
  HistoryStep,
  SanitizedContext,
  ScreenStateElement,
  StepInfo,
} from "../schemas/screenState";

export interface PreparedContext {
  /** The only object in this result that may cross the network boundary. */
  context: SanitizedContext;
  /** Client-memory-only reverse map; never serialized. */
  tokens: ClientTokenMap;
  /** Set-of-Mark id -> Screen State element id, for resolving the action target. */
  marks: Map<string, string>;
  /** Elements withheld because a detection landed in the review band. */
  withheldForReview: number;
  redactedElements: number;
  /** NAME candidates the NER verifier rejected as not-a-person (left unmasked). */
  namesRejected: number;
}

/** Scores rule-detected NAME candidates; one boolean per span per item, true = person. */
export type NameVerifierFn = (items: NameVerifyItem[]) => Promise<boolean[][]>;

export interface PrepareOptions {
  /**
   * Optional hybrid precision layer. When absent - or when it fails - every rule
   * detection stays masked, exactly as before the verifier existed: verification only
   * ever removes redactions, so its failure mode must be the redundant mask, not a leak.
   */
  verifyNames?: NameVerifierFn;
  /**
   * Multi-step context. Present only on loop steps: the payload then declares schema
   * 1.1 and carries the step counter, the (already privacy-safe) prior-step history, and
   * the current page's title - redacted below with this step's own token map before it
   * is attached, and truncated to the same 120 chars a history entry gets. It is what
   * lets the reasoner see that a navigation already reached the goal; without it the
   * model was observed re-acting on finished tasks. Never a URL.
   * Single-shot payloads stay byte-identical to what they were before the loop existed.
   */
  loop?: { step: StepInfo; history: HistoryStep[]; pageTitle?: string };
}

/**
 * Applies local text redaction before producing the only payload eligible for `/reason`.
 *
 * A `mask` decision tokenizes the value in place; a `review` decision additionally marks
 * the element sensitive so `buildContext` withholds it rather than guessing.
 */
export async function prepareContext(
  task: string,
  elements: ScreenStateElement[],
  options: PrepareOptions = {},
): Promise<PreparedContext> {
  const rejected = await rejectedNameSpans(elements, options.verifyNames);
  const namesRejected = rejected.reduce((sum, spans) => sum + (spans?.size ?? 0), 0);

  const tokens = new ClientTokenMap();
  let withheldForReview = 0;
  let redactedElements = 0;

  const sanitized = elements.map((element, index): ScreenStateElement => {
    const drops = rejected[index];
    const redaction = tokens.redact(
      element.text,
      drops && ((match) => match.type === "NAME" && drops.has(`${match.start}:${match.end}`)),
    );
    if (redaction.matches.length > 0) redactedElements += 1;
    if (redaction.requiresReview) withheldForReview += 1;

    const firstMatch = redaction.matches[0];
    return {
      ...element,
      text: redaction.text,
      sensitive: element.sensitive || redaction.requiresReview,
      ...(firstMatch ? { pii_type: firstMatch.type } : {}),
    };
  });

  const { context: built, marks } = buildContext(task, sanitized);
  const pageIdent = options.loop?.pageTitle
    ? tokens.redact(options.loop.pageTitle).text.slice(0, 120)
    : undefined;
  const context: SanitizedContext = options.loop
    ? {
        ...built,
        schema_version: "1.1",
        step: options.loop.step,
        history: options.loop.history,
        ...(pageIdent ? { page_ident: pageIdent } : {}),
      }
    : built;
  return { context, marks, tokens, withheldForReview, redactedElements, namesRejected };
}

/**
 * Collects every rule-detected NAME candidate and asks the verifier which are people.
 *
 * Returns one `"start:end"` rejection set per element (undefined = nothing rejected).
 * Candidates are taken before span resolution so a rejection cannot leave a shadowed
 * overlapping detection unresolved. On any verifier error the answer is "reject nothing":
 * the pipeline then masks exactly what it masked before the verifier existed.
 */
async function rejectedNameSpans(
  elements: ScreenStateElement[],
  verify?: NameVerifierFn,
): Promise<(Set<string> | undefined)[]> {
  const none = elements.map(() => undefined);
  if (!verify) return none;

  const indexed: { index: number; item: NameVerifyItem }[] = [];
  for (const [index, element] of elements.entries()) {
    const spans = detectPii(element.text)
      .filter((match) => match.type === "NAME")
      .map((match) => ({ start: match.start, end: match.end }));
    if (spans.length > 0) indexed.push({ index, item: { text: element.text, spans } });
  }
  if (indexed.length === 0) return none;

  try {
    const confirmed = await verify(indexed.map((entry) => entry.item));
    const rejected: (Set<string> | undefined)[] = elements.map(() => undefined);
    for (const [position, entry] of indexed.entries()) {
      const drops = new Set<string>();
      for (const [spanIndex, span] of entry.item.spans.entries()) {
        // Strict `=== false`: a missing or malformed verdict keeps the mask.
        if (confirmed[position]?.[spanIndex] === false) drops.add(`${span.start}:${span.end}`);
      }
      if (drops.size > 0) rejected[entry.index] = drops;
    }
    return rejected;
  } catch (error) {
    console.warn(
      "PrivAgent name verification unavailable; keeping every rule-detected mask.",
      error instanceof Error ? error.message : error,
    );
    return none;
  }
}
