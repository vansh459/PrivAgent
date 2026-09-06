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
        # Multi-step awareness, kept as simple as the provider itself: if a prior step
        # already executed an action for this task, the conservative next answer is
        # "done" - repeating the same keyword match would click the same element forever.
        if any(entry.outcome.startswith("executed") for entry in context.history):
            return Action(
                action="done",
                params={"summary": "A previous step already executed the matching action."},
                confidence=0.6,
                risk="low",
                explanation="The history shows the matching action was already executed.",
                reasoning_trace_id=new_trace_id(),
            )

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


class FallbackProvider:
    """Tries providers in order, falling through only on *unavailability*.

    Only `ModelUnavailableError` - endpoint unreachable, model missing, bad config -
    triggers the next provider. A provider that answered `none` gave an answer; second
    opinions on answers would make behaviour depend on which models happened to be up.
    """

    def __init__(self, *providers: ReasonProvider) -> None:
        assert providers, "FallbackProvider needs at least one provider"
        self.providers = providers
        self.name = " -> ".join(provider.name for provider in providers)

    def reason(self, context: SanitizedContext) -> Action:
        from .ollama import ModelUnavailableError

        last_error: Exception | None = None
        for provider in self.providers:
            try:
                return provider.reason(context)
            except ModelUnavailableError as error:
                last_error = error
                print(f"[privagent] {provider.name} unavailable ({error}); falling back.")
        raise last_error if last_error else RuntimeError("no provider answered")


def _select_provider() -> ReasonProvider:
    """Chooses the reasoner from the environment.

    The deterministic baseline stays the default so that CI, and anyone who has just
    cloned the repository, gets a working server with no model, no download and no
    network. A model is opt-in - `PRIVAGENT_REASONER=ollama` - because a server that
    silently required a 1 GB download to answer would be a worse default than one that
    answers conservatively.

    `foundry` selects the chain foundry -> ollama -> deterministic: the remote Claude
    deployment is the brain, the local open-source model takes over the moment the
    endpoint is unreachable, and the keyword baseline guarantees an answer offline. The
    PS-compliance boundary is unchanged - rubric measurements and the judged demo run
    `PRIVAGENT_REASONER=ollama`, where nothing leaves the machine.
    """
    selected = os.environ.get("PRIVAGENT_REASONER", "deterministic").lower()
    if selected == "ollama":
        from .ollama import provider_from_env

        return provider_from_env()
    if selected == "foundry":
        from .foundry import provider_from_env as foundry_from_env
        from .ollama import provider_from_env as ollama_from_env

        return FallbackProvider(foundry_from_env(), ollama_from_env(), DeterministicProvider())
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
