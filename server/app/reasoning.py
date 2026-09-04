from .schemas import Action, SanitizedContext


def reason(context: SanitizedContext) -> Action:
    """Deterministic local-safe baseline until a configured model provider is available."""
    terms = set(context.task.lower().split())
    for element in context.elements:
        if element.role in {"button", "link", "menuitem"} and (not terms or terms & set(element.text.lower().split())):
            return Action(action="click", target_id=element.markId, confidence=0.8, explanation="Matched the requested action to a sanitized interactive mark.")
    return Action(action="none", confidence=0.0, explanation="No safe matching action was found in the sanitized context.")
