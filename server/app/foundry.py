"""Reasoning against a Claude model deployed on Azure AI Foundry (Anthropic Messages API).

**This provider is additive and is not the PS-compliance path.** SIH PS 26171 requires an
offline-deployable open-source LLM; that remains Ollama/Qwen (`ollama.py`), which backs
every rubric measurement and the judged demo. This provider exists for the universal
multi-step browsing capability, where a frontier model's planning is worth the trade -
and the trade is stated plainly: the *sanitized, tokenized* context leaves the machine
for the user's own Azure deployment. The privacy boundary is unchanged - the same
schema-validated `SanitizedContext` is the only thing sent, raw values and the token map
never leave the client - but "local-only inference" does not hold while this provider is
selected, and docs/SECURITY.md says so.

Configuration is environment-only, because a key in a file ends up in a repository:

    PRIVAGENT_REASONER=foundry
    PRIVAGENT_FOUNDRY_BASE_URL=https://<resource>.services.ai.azure.com/anthropic
    PRIVAGENT_FOUNDRY_API_KEY=<key>          (never committed; .env is untracked)
    PRIVAGENT_FOUNDRY_MODEL=claude-fable-5   (optional; this is the default)

The action shape is enforced with a forced tool call rather than prompt pleading: the
API is required to answer through a single tool whose input schema *is* `ModelAction`,
and the reply is then re-validated and semantically checked exactly like Ollama's -
a hallucinated mark id is rejected, retried once, then refused with a safe `none`.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
from pydantic import ValidationError

from .ollama import ModelUnavailableError, _semantic_problem, _to_action
from .prompt import SYSTEM_PROMPT, ModelAction, render_context, response_format
from .schemas import Action, SanitizedContext

DEFAULT_MODEL = "claude-fable-5"
DEFAULT_TIMEOUT_SECONDS = 30.0
ANTHROPIC_VERSION = "2023-06-01"

TOOL_NAME = "propose_action"


class Transport(Protocol):
    """The one HTTP call this provider makes, injectable so tests need no network."""

    def post(
        self, url: str, json: dict[str, Any], headers: dict[str, str], timeout: float
    ) -> dict[str, Any]: ...


class HttpxTransport:
    def post(
        self, url: str, json: dict[str, Any], headers: dict[str, str], timeout: float
    ) -> dict[str, Any]:
        response = httpx.post(url, json=json, headers=headers, timeout=timeout)
        response.raise_for_status()
        return response.json()


@dataclass
class FoundryProvider:
    """Calls an Anthropic Messages endpoint and validates every field of what returns."""

    base_url: str
    api_key: str
    model: str = DEFAULT_MODEL
    timeout: float = DEFAULT_TIMEOUT_SECONDS
    transport: Transport | None = None

    name: str = "foundry"

    def __post_init__(self) -> None:
        self.transport = self.transport or HttpxTransport()
        self.name = f"foundry:{self.model}"

    def reason(self, context: SanitizedContext) -> Action:
        marks = {element.mark_id for element in context.elements}
        elements = [element.model_dump() for element in context.elements]
        step = context.step.model_dump() if context.step else None
        history = [entry.model_dump() for entry in context.history] or None
        messages: list[dict[str, Any]] = [
            {
                "role": "user",
                "content": render_context(
                    context.task, elements, step, history, context.page_ident
                ),
            }
        ]

        rejection: str | None = None
        # One retry, and only one - same policy and same reasoning as the Ollama provider.
        for attempt in range(2):
            if rejection:
                messages = messages + [
                    {"role": "user", "content": f"That answer was rejected: {rejection}. Try again."}
                ]

            proposed_input = self._call(messages)
            try:
                proposed = ModelAction.model_validate(proposed_input)
            except ValidationError as error:
                rejection = (
                    f"the tool input did not match the required shape ({error.error_count()} problems)"
                )
                continue

            problem = _semantic_problem(proposed, marks)
            if problem:
                rejection = problem
                continue

            return _to_action(proposed, attempt)

        return Action(
            action="none",
            confidence=0.0,
            risk="low",
            explanation="The remote model did not return a usable action, so nothing was done.",
            reasoning_trace_id=f"trace_foundry_rejected_{uuid.uuid4().hex[:8]}",
        )

    def _call(self, messages: list[dict[str, Any]]) -> dict[str, Any]:
        assert self.transport is not None
        try:
            payload = self.transport.post(
                f"{self.base_url.rstrip('/')}/v1/messages",
                json={
                    "model": self.model,
                    "max_tokens": 512,
                    "system": SYSTEM_PROMPT,
                    "messages": messages,
                    # The reply must arrive as this one tool call; there is no prose path.
                    "tools": [
                        {
                            "name": TOOL_NAME,
                            "description": "Propose the single next action for the browser agent.",
                            "input_schema": response_format(),
                        }
                    ],
                    "tool_choice": {"type": "tool", "name": TOOL_NAME},
                    # No `temperature`: the Claude 5 family rejects it as deprecated
                    # ("`temperature` is deprecated for this model", observed live), so
                    # unlike the local model this provider cannot pin decoding - the
                    # semantic validation below is the reproducibility backstop.
                },
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": ANTHROPIC_VERSION,
                    "content-type": "application/json",
                },
                timeout=self.timeout,
            )
        except Exception as error:  # noqa: BLE001 - surfaced as one typed failure
            raise ModelUnavailableError(
                f"Could not reach the Foundry deployment at {self.base_url}: {error}"
            ) from error

        for block in payload.get("content", []):
            if block.get("type") == "tool_use" and block.get("name") == TOOL_NAME:
                tool_input = block.get("input")
                return tool_input if isinstance(tool_input, dict) else {}
        return {}


def provider_from_env() -> FoundryProvider:
    base_url = os.environ.get("PRIVAGENT_FOUNDRY_BASE_URL", "")
    api_key = os.environ.get("PRIVAGENT_FOUNDRY_API_KEY", "")
    if not base_url or not api_key:
        raise ModelUnavailableError(
            "PRIVAGENT_REASONER=foundry needs PRIVAGENT_FOUNDRY_BASE_URL and "
            "PRIVAGENT_FOUNDRY_API_KEY in the environment (see server/.env.example)"
        )
    return FoundryProvider(
        base_url=base_url,
        api_key=api_key,
        model=os.environ.get("PRIVAGENT_FOUNDRY_MODEL", DEFAULT_MODEL),
        timeout=float(os.environ.get("PRIVAGENT_FOUNDRY_TIMEOUT", DEFAULT_TIMEOUT_SECONDS)),
    )
