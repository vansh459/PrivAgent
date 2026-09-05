"""Reasoning providers for the `/reason` endpoint.

The provider seam exists so the deterministic baseline can back CI and offline runs while
a real open-weight model backs demos, without the endpoint or the client knowing which is
in play. Every provider must return a schema-valid `Action`; the endpoint re-validates.
"""

from __future__ import annotations

import os
import uuid
from typing import Protocol

from .schemas import Action, SanitizedContext

CLICKABLE_ROLES = frozenset({"button", "link", "menuitem"})


def new_trace_id() -> str:
    return f"trace_{uuid.uuid4().hex[:12]}"


class ReasonProvider(Protocol):
    """Turns a sanitized context into a proposed next action."""

    name: str

    def reason(self, context: SanitizedContext) -> Action: ...


class DeterministicProvider:
    """Keyword baseline. No model, no network - used by CI and as an offline fallback.

    It is intentionally conservative: if nothing on the page matches the task, it returns
    `none` rather than guessing at an element the user did not ask for.
    """

    name = "deterministic"

    def reason(self, context: SanitizedContext) -> Action:
        terms = {term for term in context.task.lower().split() if len(term) > 2}

        for element in context.elements:
            if element.role not in CLICKABLE_ROLES:
                continue
            words = set(element.text.lower().split())
            if not terms or terms & words:
                return Action(
                    action="click",
                    target_id=element.mark_id,
                    confidence=0.8,
                    risk="low",
                    explanation=f"Matched the task to the {element.role} labelled {element.text!r}.",
                    reasoning_trace_id=new_trace_id(),
                )

        return Action(
            action="none",
            confidence=0.0,
            risk="low",
            explanation="No safe matching action was found in the sanitized context.",
            reasoning_trace_id=new_trace_id(),
        )


def _select_provider() -> ReasonProvider:
    """Chooses the reasoner from the environment.

    The deterministic baseline stays the default so that CI, and anyone who has just
    cloned the repository, gets a working server with no model, no download and no
    network. A model is opt-in - `PRIVAGENT_REASONER=ollama` - because a server that
    silently required a 1 GB download to answer would be a worse default than one that
    answers conservatively.
    """
    if os.environ.get("PRIVAGENT_REASONER", "deterministic").lower() == "ollama":
        from .ollama import provider_from_env

        return provider_from_env()
    return DeterministicProvider()


_provider: ReasonProvider = _select_provider()


def get_provider() -> ReasonProvider:
    return _provider


def set_provider(provider: ReasonProvider) -> None:
    """Swaps the active provider. Used by app startup and by tests."""
    global _provider
    _provider = provider


def reason(context: SanitizedContext) -> Action:
    return _provider.reason(context)
