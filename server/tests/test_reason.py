import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.reasoning import DeterministicProvider
from app.schemas import Action, SanitizedContext

client = TestClient(app)


def context(*elements: dict[str, object]) -> dict[str, object]:
    return {"schema_version": "1.0", "task": "click download", "elements": list(elements)}


def mark(mark_id: str, role: str, text: str) -> dict[str, object]:
    return {"mark_id": mark_id, "role": role, "text": text, "bbox": [0, 0, 10, 10]}


def test_reason_returns_a_schema_valid_action_for_sanitized_context() -> None:
    response = client.post("/reason", json=context(mark("M1", "button", "Download report")))

    assert response.status_code == 200
    action = Action.model_validate(response.json())
    assert action.action == "click"
    assert action.target_id == "M1"
    assert action.explanation
    assert action.reasoning_trace_id.startswith("trace_")


def test_reason_declines_rather_than_guessing_when_nothing_matches() -> None:
    response = client.post("/reason", json=context(mark("M1", "button", "Cancel subscription")))

    assert response.status_code == 200
    assert response.json()["action"] == "none"


@pytest.mark.parametrize(
    "payload",
    [
        {"task": "click"},
        {"schema_version": "2.0", "task": "click", "elements": []},
        context({"mark_id": "not-a-mark", "role": "button", "text": "x", "bbox": [0, 0, 1, 1]}),
        context({"mark_id": "M1", "role": "button", "text": "x", "bbox": [0, 0, 1]}),
    ],
)
def test_reason_rejects_malformed_payloads(payload: dict[str, object]) -> None:
    assert client.post("/reason", json=payload).status_code == 422


def test_extra_fields_are_rejected_so_a_raw_value_cannot_ride_along() -> None:
    payload = context(mark("M1", "button", "Download report"))
    payload["raw_screenshot"] = "data:image/png;base64,AAAA"

    assert client.post("/reason", json=payload).status_code == 422


def test_deterministic_provider_is_offline_and_returns_a_valid_action() -> None:
    parsed = SanitizedContext.model_validate(context(mark("M1", "link", "Download report")))
    action = DeterministicProvider().reason(parsed)

    assert isinstance(action, Action)
    assert action.target_id == "M1"
