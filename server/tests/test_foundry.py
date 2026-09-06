"""The Foundry (Anthropic Messages API) provider, tested without a network.

Same philosophy as `test_ollama.py`: the paths that matter are the ones a live model makes
hard to trigger on purpose - a hallucinated mark id, a malformed tool input, a dead
endpoint, a missing configuration. A scripted transport replays Anthropic-shaped replies
and records exactly what would have been sent, which is also where the privacy assertion
lives: the request body must carry the sanitized context and nothing else.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.foundry import TOOL_NAME, FoundryProvider, provider_from_env
from app.ollama import ModelUnavailableError
from app.schemas import SanitizedContext


def tool_reply(**fields: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "action": "click",
        "target_id": "M1",
        "params": {},
        "confidence": 0.9,
        "risk": "low",
        "explanation": "Clicking the download link.",
    }
    body.update(fields)
    return {"content": [{"type": "tool_use", "name": TOOL_NAME, "input": body}]}


class ScriptedTransport:
    """Replays prepared API replies and records every request it was handed."""

    def __init__(self, *replies: dict[str, Any]) -> None:
        self.replies = list(replies)
        self.requests: list[dict[str, Any]] = []
        self.headers: list[dict[str, str]] = []

    def post(
        self, url: str, json: dict[str, Any], headers: dict[str, str], timeout: float
    ) -> dict[str, Any]:
        self.requests.append(json)
        self.headers.append(headers)
        return self.replies.pop(0) if self.replies else {"content": []}


class DeadTransport:
    def post(
        self, url: str, json: dict[str, Any], headers: dict[str, str], timeout: float
    ) -> dict[str, Any]:
        raise ConnectionError("connection refused")


def context(task: str = "download the report") -> SanitizedContext:
    return SanitizedContext.model_validate(
        {
            "schema_version": "1.0",
            "task": task,
            "elements": [
                {"mark_id": "M1", "role": "link", "text": "Download report", "bbox": [0, 0, 10, 10]},
                {"mark_id": "M2", "role": "button", "text": "Cancel", "bbox": [0, 20, 10, 10]},
            ],
        }
    )


def provider(*replies: dict[str, Any]) -> tuple[FoundryProvider, ScriptedTransport]:
    transport = ScriptedTransport(*replies)
    return (
        FoundryProvider(base_url="https://example.invalid/anthropic", api_key="k", transport=transport),
        transport,
    )


def test_valid_tool_use_becomes_an_action() -> None:
    reasoner, _ = provider(tool_reply())

    action = reasoner.reason(context())

    assert action.action == "click"
    assert action.target_id == "M1"


def test_forces_the_tool_and_sends_only_sanitized_content() -> None:
    reasoner, transport = provider(tool_reply())

    reasoner.reason(context())

    request = transport.requests[0]
    assert request["tool_choice"] == {"type": "tool", "name": TOOL_NAME}
    assert request["temperature"] == 0
    # The user turn is the rendered sanitized context: marks and redacted text only.
    user_text = request["messages"][0]["content"]
    assert "M1" in user_text and "Download report" in user_text
    assert transport.headers[0]["x-api-key"] == "k"


def test_hallucinated_target_is_rejected_then_refused() -> None:
    reasoner, transport = provider(
        tool_reply(target_id="M99"), tool_reply(target_id="M99")
    )

    action = reasoner.reason(context())

    assert action.action == "none"
    assert len(transport.requests) == 2  # exactly one retry
    assert "rejected" in transport.requests[1]["messages"][-1]["content"]


def test_retry_can_recover_a_first_bad_answer() -> None:
    reasoner, _ = provider(tool_reply(target_id="M99"), tool_reply(target_id="M2"))

    action = reasoner.reason(context())

    assert action.action == "click"
    assert action.target_id == "M2"


def test_malformed_tool_input_is_refused_safely() -> None:
    reasoner, _ = provider(
        {"content": [{"type": "tool_use", "name": TOOL_NAME, "input": {"action": "explode"}}]},
        {"content": [{"type": "text", "text": "I think you should click M1"}]},
    )

    action = reasoner.reason(context())

    assert action.action == "none"
    assert action.confidence == 0.0


def test_dead_endpoint_raises_model_unavailable() -> None:
    reasoner = FoundryProvider(
        base_url="https://example.invalid/anthropic", api_key="k", transport=DeadTransport()
    )

    with pytest.raises(ModelUnavailableError):
        reasoner.reason(context())


def test_env_configuration_is_required(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PRIVAGENT_FOUNDRY_BASE_URL", raising=False)
    monkeypatch.delenv("PRIVAGENT_FOUNDRY_API_KEY", raising=False)

    with pytest.raises(ModelUnavailableError, match="PRIVAGENT_FOUNDRY_BASE_URL"):
        provider_from_env()


def test_env_configuration_builds_the_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PRIVAGENT_FOUNDRY_BASE_URL", "https://res.services.ai.azure.com/anthropic")
    monkeypatch.setenv("PRIVAGENT_FOUNDRY_API_KEY", "secret")
    monkeypatch.setenv("PRIVAGENT_FOUNDRY_MODEL", "claude-fable-5")

    built = provider_from_env()

    assert built.name == "foundry:claude-fable-5"
    assert built.base_url.endswith("/anthropic")
