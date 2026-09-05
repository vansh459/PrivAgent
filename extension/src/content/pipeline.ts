import { buildContext } from "./contextBuilder";
import { ClientTokenMap } from "./privacy";
import type { SanitizedContext, ScreenStateElement } from "../schemas/screenState";

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
}

/**
 * Applies local text redaction before producing the only payload eligible for `/reason`.
 *
 * A `mask` decision tokenizes the value in place; a `review` decision additionally marks
 * the element sensitive so `buildContext` withholds it rather than guessing.
 */
export function prepareContext(task: string, elements: ScreenStateElement[]): PreparedContext {
  const tokens = new ClientTokenMap();
  let withheldForReview = 0;
  let redactedElements = 0;

  const sanitized = elements.map((element): ScreenStateElement => {
    const redaction = tokens.redact(element.text);
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

  const { context, marks } = buildContext(task, sanitized);
  return { context, marks, tokens, withheldForReview, redactedElements };
}
