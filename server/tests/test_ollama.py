"""The model provider's validation, tested without a model.

Everything here runs offline against a stubbed transport, because these are the paths that
matter most and are hardest to trigger on purpose with a real model: a hallucinated mark
id, a shape the schema rejects, a runtime that is not running. The real model is exercised
separately in `test_ollama_live.py`, which skips when Ollama is not installed.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.ollama import ModelUnavailableError, OllamaProvider, _semantic_problem
from app.prompt import SYSTEM_PROMPT_VERSION, ModelAction, render_context
from app.schemas import SanitizedContext


class ScriptedTransport:
    """Replays prepared model replies and records what it was asked."""

    def __init__(self, *replies: str) -> None:
        self.replies = list(replies)
        self.requests: list[dict[str, Any]] = []

    def post(self, url: str, json: dict[str, Any], timeout: float) -> dict[str, Any]:
        self.requests.append(json)
        reply = self.replies.pop(0) if self.replies else ""
        return {"message": {"content": reply}}


class DeadTransport:
    def post(self, url: str, json: dict[str, Any], timeout: float) -> dict[str, Any]:
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


def reply(**fields: Any) -> str:
    body = {
        "action": "click",
        "target_id": "M1",
        "params": {},
        "confidence": 0.9,
        "risk": "low",
        "explanation": "Clicking the download link.",
    }
    body.update(fields)
    return json.dumps(body)


def test_valid_model_output_becomes_an_action() -> None:
    provider = OllamaProvider(transport=ScriptedTransport(reply()))

    action = provider.reason(context())

    assert action.action == "click"
    assert action.target_id == "M1"
    assert action.explanation == "Clicking the download link."


def test_trace_id_records_the_prompt_version() -> None:
    """An action that cannot be traced to the prompt that produced it is not reproducible."""
    provider = OllamaProvider(transport=ScriptedTransport(reply()))

    assert f"p{SYSTEM_PROMPT_VERSION}" in provider.reason(context()).reasoning_trace_id


def test_a_hallucinated_mark_is_rejected_and_retried() -> None:
    # The dangerous case: M7 was never sent, so the client would resolve it against
    # whatever element happens to hold that mark - or fail. Either way it is not what the
    # model looked at.
    transport = ScriptedTransport(reply(target_id="M7"), reply(target_id="M2"))
    provider = OllamaProvider(transport=transport)

    action = provider.reason(context())

    assert action.target_id == "M2"
    assert len(transport.requests) == 2
    assert "not one of the marks" in transport.requests[1]["messages"][-1]["content"]


def test_output_that_is_not_valid_json_is_never_forwarded() -> None:
    provider = OllamaProvider(transport=ScriptedTransport("Sure! I'll click the link.", "still not json"))

    action = provider.reason(context())

    assert action.action == "none"
    assert action.confidence == 0.0
    assert "did not return a usable action" in action.explanation


def test_a_persistent_hallucination_ends_in_no_action() -> None:
    provider = OllamaProvider(transport=ScriptedTransport(reply(target_id="M9"), reply(target_id="M8")))

    assert provider.reason(context()).action == "none"


def test_a_type_action_without_text_is_rejected() -> None:
    provider = OllamaProvider(
        transport=ScriptedTransport(
            reply(action="type", target_id="M1", params={}),
            reply(action="type", target_id="M1", params={"text": "invoices"}),
        )
    )

    action = provider.reason(context("search for invoices"))

    assert action.action == "type"
    assert action.params == {"text": "invoices"}


def test_the_request_is_constrained_to_the_action_schema() -> None:
    transport = ScriptedTransport(reply())
    OllamaProvider(transport=transport).reason(context())

    request = transport.requests[0]
    assert request["stream"] is False
    assert request["options"]["temperature"] == 0
    assert request["format"]["properties"].keys() == ModelAction.model_fields.keys()


def test_an_unreachable_runtime_is_reported_as_such() -> None:
    provider = OllamaProvider(transport=DeadTransport())

    with pytest.raises(ModelUnavailableError, match="Could not reach the local model"):
        provider.reason(context())


def test_the_provider_names_its_model() -> None:
    """/health reports this, so a trace can be read against the model that produced it."""
    assert OllamaProvider(model="qwen2.5:1.5b", transport=ScriptedTransport()).name == (
        "ollama:qwen2.5:1.5b"
    )


@pytest.mark.parametrize(
    ("proposed", "expected"),
    [
        ({"action": "click", "target_id": None}, "needs a target_id"),
        ({"action": "click", "target_id": "M9"}, "not one of the marks"),
        ({"action": "navigate", "params": {}}, "needs params.url"),
        ({"action": "none", "target_id": None}, None),
        ({"action": "scroll", "target_id": None}, None),
    ],
)
def test_semantic_checks(proposed: dict[str, Any], expected: str | None) -> None:
    # Every field is required now - that is the point of the schema handed to the
    # decoder - so the base here supplies them all and each case overrides what it tests.
    action = ModelAction.model_validate(
        {
            "target_id": None,
            "params": {},
            "confidence": 0.5,
            "risk": "low",
            "explanation": "x",
            **proposed,
        }
    )
    problem = _semantic_problem(action, {"M1", "M2"})

    if expected is None:
        assert problem is None
    else:
        assert problem is not None and expected in problem


def test_the_context_is_rendered_compactly() -> None:
    rendered = render_context("download the report", [
        {"mark_id": "M1", "role": "link", "text": "Download report", "bbox": [0, 0, 10, 10]},
    ])

    assert "Task: download the report" in rendered
    assert "M1 [link] 'Download report'" in rendered


def test_an_empty_screen_still_renders() -> None:
    assert "(none visible)" in render_context("do something", [])
