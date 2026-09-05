"""Reasoning against a locally hosted open-weight model, served by Ollama.

Hosting choice, stated for the record: the model runs on the user's own machine through
Ollama, not on a hosted API. The point of this project is that the screen never leaves the
device; sending the sanitized context to someone else's inference service would keep that
literally true while giving away the thing the user was actually protecting - what they
are doing, on which page, at what time. A local model keeps the whole loop on one machine.

The provider is deliberately paranoid about what comes back. A model that names an element
that does not exist would have the client click whatever happens to carry that mark, so a
hallucinated `target_id` is treated as malformed output and retried, then refused.
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
from pydantic import ValidationError

from .prompt import (
    SYSTEM_PROMPT,
    SYSTEM_PROMPT_VERSION,
    ModelAction,
    render_context,
    response_format,
)
from .schemas import Action, SanitizedContext

# Chosen by measurement, not by size. On ten task payloads with the same prompt:
# qwen2.5:1.5b scored 8/10 correct at a ~7-13 s median, llama3.2:1b scored 3/10 at ~13 s.
# See `scripts/compare-reasoners.py`, which is what produced those numbers.
DEFAULT_MODEL = "qwen2.5:1.5b"
DEFAULT_BASE_URL = "http://127.0.0.1:11434"
DEFAULT_TIMEOUT_SECONDS = 60.0


class Transport(Protocol):
    """The one HTTP call this provider makes, injectable so tests need no server."""

    def post(self, url: str, json: dict[str, Any], timeout: float) -> dict[str, Any]: ...


class HttpxTransport:
    def post(self, url: str, json: dict[str, Any], timeout: float) -> dict[str, Any]:
        response = httpx.post(url, json=json, timeout=timeout)
        response.raise_for_status()
        return response.json()


class ModelUnavailableError(RuntimeError):
    """The local runtime could not be reached or the model is not installed."""


@dataclass
class OllamaProvider:
    """Calls a local Ollama model and validates every field of what it returns."""

    model: str = DEFAULT_MODEL
    base_url: str = DEFAULT_BASE_URL
    timeout: float = DEFAULT_TIMEOUT_SECONDS
    transport: Transport | None = None

    name: str = "ollama"

    def __post_init__(self) -> None:
        self.transport = self.transport or HttpxTransport()
        self.name = f"ollama:{self.model}"

    def reason(self, context: SanitizedContext) -> Action:
        marks = {element.mark_id for element in context.elements}
        elements = [element.model_dump() for element in context.elements]
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": render_context(context.task, elements)},
        ]

        rejection: str | None = None
        # One retry, and only one. If a model has produced an invalid target twice, a
        # third attempt is latency spent on the same misunderstanding; refusing is both
        # faster and safer than eventually accepting something questionable.
        for attempt in range(2):
            if rejection:
                messages = messages + [
                    {"role": "user", "content": f"That answer was rejected: {rejection}. Try again."}
                ]

            raw = self._call(messages)
            try:
                proposed = ModelAction.model_validate_json(raw)
            except ValidationError as error:
                rejection = f"the JSON did not match the required shape ({error.error_count()} problems)"
                continue

            problem = _semantic_problem(proposed, marks)
            if problem:
                rejection = problem
                continue

            return _to_action(proposed, attempt)

        # Never forward unvalidated model output. `none` is the safe answer, and it is
        # reported honestly rather than dressed up as a decision.
        return Action(
            action="none",
            confidence=0.0,
            risk="low",
            explanation="The local model did not return a usable action, so nothing was done.",
            reasoning_trace_id=_trace_id("rejected"),
        )

    def _call(self, messages: list[dict[str, str]]) -> str:
        assert self.transport is not None
        try:
            payload = self.transport.post(
                f"{self.base_url.rstrip('/')}/api/chat",
                json={
                    "model": self.model,
                    "messages": messages,
                    "stream": False,
                    "format": response_format(),
                    # Deterministic decoding: the same screen and task should produce the
                    # same proposal, or nothing in this pipeline is reproducible.
                    "options": {"temperature": 0},
                },
                timeout=self.timeout,
            )
        except Exception as error:  # noqa: BLE001 - surfaced as one typed failure
            raise ModelUnavailableError(
                f"Could not reach the local model at {self.base_url}: {error}"
            ) from error

        content = payload.get("message", {}).get("content", "")
        return content if isinstance(content, str) else ""


def _semantic_problem(proposed: ModelAction, marks: set[str]) -> str | None:
    """Checks the parts a JSON schema cannot: does this action refer to something real?"""
    if proposed.action in {"click", "type"}:
        if not proposed.target_id:
            return f"a {proposed.action} needs a target_id"
        if proposed.target_id not in marks:
            # The dangerous case. A mark that was never sent is a hallucination, and the
            # client would resolve it against whatever element now holds that id.
            return f"target_id {proposed.target_id!r} is not one of the marks you were given"
    if proposed.action == "type" and not proposed.params.get("text"):
        return "a type action needs params.text"
    if proposed.action == "navigate" and not proposed.params.get("url"):
        return "a navigate action needs params.url"
    return None


def _to_action(proposed: ModelAction, attempt: int) -> Action:
    return Action(
        action=proposed.action,
        target_id=proposed.target_id if proposed.action in {"click", "type"} else None,
        params=proposed.params,
        confidence=proposed.confidence,
        risk=proposed.risk,
        explanation=proposed.explanation,
        reasoning_trace_id=_trace_id("retry" if attempt else "ok"),
    )


def _trace_id(outcome: str) -> str:
    """Ties an action back to the prompt version and attempt that produced it."""
    return f"trace_p{SYSTEM_PROMPT_VERSION}_{outcome}_{uuid.uuid4().hex[:8]}"


def provider_from_env() -> OllamaProvider:
    return OllamaProvider(
        model=os.environ.get("PRIVAGENT_OLLAMA_MODEL", DEFAULT_MODEL),
        base_url=os.environ.get("PRIVAGENT_OLLAMA_URL", DEFAULT_BASE_URL),
        timeout=float(os.environ.get("PRIVAGENT_OLLAMA_TIMEOUT", DEFAULT_TIMEOUT_SECONDS)),
    )


def is_available(base_url: str = DEFAULT_BASE_URL, model: str = DEFAULT_MODEL) -> bool:
    """True when the local runtime answers and has the model installed."""
    try:
        response = httpx.get(f"{base_url.rstrip('/')}/api/tags", timeout=3.0)
        response.raise_for_status()
        installed = {entry.get("name", "") for entry in response.json().get("models", [])}
    except Exception:  # noqa: BLE001 - availability probe, any failure means "no"
        return False
    return model in installed or any(name.startswith(f"{model}:") for name in installed)


def json_dumps(value: object) -> str:
    return json.dumps(value, separators=(",", ":"))
