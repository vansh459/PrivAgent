"""Schema v1.1: the multi-step vocabulary, validated at the wire boundary.

The additions must be backward compatible (every 1.0 payload stays valid), terminal
actions must carry their required parameters, and the history must never be a place a
URL can hide - `page_ident` is a redacted title by contract, and the prompt renderer
must pass through only what arrived.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.prompt import render_context
from app.reasoning import DeterministicProvider
from app.schemas import Action, SanitizedContext


def payload_v10() -> dict[str, object]:
    return {
        "schema_version": "1.0",
        "task": "download the report",
        "elements": [
            {"mark_id": "M1", "role": "link", "text": "Download report", "bbox": [0, 0, 10, 10]}
        ],
    }


def test_a_v10_payload_is_still_valid() -> None:
    context = SanitizedContext.model_validate(payload_v10())
    assert context.step is None
    assert context.history == []


def test_a_v11_payload_carries_step_and_history() -> None:
    body = payload_v10() | {
        "schema_version": "1.1",
        "step": {"n": 3, "limit": 15},
        "history": [
            {
                "action": "click",
                "target_role": "link",
                "outcome": "executed click",
                "page_ident": "Expenditure Portal",
            }
        ],
    }
    context = SanitizedContext.model_validate(body)
    assert context.step is not None and context.step.n == 3
    assert context.history[0].page_ident == "Expenditure Portal"


def test_unknown_history_fields_are_rejected() -> None:
    body = payload_v10() | {
        "schema_version": "1.1",
        "history": [
            {
                "action": "click",
                "outcome": "executed click",
                "page_ident": "t",
                "url": "https://example.com/leak",
            }
        ],
    }
    with pytest.raises(ValidationError):
        SanitizedContext.model_validate(body)


def test_done_action_is_valid_without_a_target() -> None:
    action = Action(
        action="done",
        params={"summary": "The report was downloaded."},
        confidence=0.9,
        risk="low",
        explanation="The task is complete.",
        reasoning_trace_id="trace_x",
    )
    assert action.target_id is None


def test_blocked_requires_a_recognised_reason() -> None:
    with pytest.raises(ValidationError, match="params.reason"):
        Action(
            action="blocked",
            params={},
            confidence=0.9,
            risk="low",
            explanation="Stopping.",
            reasoning_trace_id="trace_x",
        )
    action = Action(
        action="blocked",
        params={"reason": "bot_detection"},
        confidence=0.9,
        risk="low",
        explanation="This site blocks automation.",
        reasoning_trace_id="trace_x",
    )
    assert action.params["reason"] == "bot_detection"


def test_render_context_includes_step_and_history_lines() -> None:
    text = render_context(
        "download the report",
        [{"mark_id": "M1", "role": "link", "text": "Download", "bbox": [0, 0, 1, 1]}],
        step={"n": 2, "limit": 15},
        history=[
            {
                "action": "click",
                "target_role": "link",
                "outcome": "executed click",
                "page_ident": "Portal Home",
            }
        ],
    )
    assert "Step 2 of at most 15." in text
    assert "1. click on a link -> executed click [page: Portal Home]" in text


def test_current_page_ident_is_accepted_and_rendered() -> None:
    body = payload_v10() | {
        "schema_version": "1.1",
        "step": {"n": 2, "limit": 15},
        "page_ident": "Report Detail",
    }
    context = SanitizedContext.model_validate(body)
    assert context.page_ident == "Report Detail"

    text = render_context("open the report page", [], page_ident="Report Detail")
    assert "Current page title: 'Report Detail'" in text
    # Absent means absent: a 1.0 single-shot payload renders no location line at all.
    assert "Current page title" not in render_context("open the report page", [])


def test_page_ident_length_is_capped_like_a_history_entry() -> None:
    body = payload_v10() | {"schema_version": "1.1", "page_ident": "x" * 121}
    try:
        SanitizedContext.model_validate(body)
        raise AssertionError("a 121-char page_ident must be rejected")
    except ValueError:
        pass


def test_deterministic_answers_done_when_history_shows_execution() -> None:
    body = payload_v10() | {
        "schema_version": "1.1",
        "history": [
            {"action": "click", "target_role": "link", "outcome": "executed click", "page_ident": "t"}
        ],
    }
    action = DeterministicProvider().reason(SanitizedContext.model_validate(body))
    assert action.action == "done"
    assert action.params.get("summary")
