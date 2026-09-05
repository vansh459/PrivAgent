"""Guards on the authoritative wire contract itself."""

import pytest
from pydantic import ValidationError

from app.schemas import Action, ScreenStateElement


def element(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": "dom_1",
        "role": "button",
        "text": "Save",
        "bbox": [0, 0, 10, 10],
        "source": "dom",
        "sensitive": False,
    }
    return {**base, **overrides}


def test_vision_elements_must_carry_confidence() -> None:
    with pytest.raises(ValidationError, match="confidence"):
        ScreenStateElement.model_validate(element(source="vision_ocr"))

    assert ScreenStateElement.model_validate(element(source="vision_ocr", confidence=0.9))


def test_dom_elements_do_not_require_confidence() -> None:
    assert ScreenStateElement.model_validate(element()).confidence is None


def test_targeted_actions_must_name_a_mark() -> None:
    with pytest.raises(ValidationError, match="target_id"):
        Action.model_validate(
            {
                "action": "click",
                "confidence": 0.9,
                "risk": "low",
                "explanation": "x",
                "reasoning_trace_id": "trace_1",
            }
        )


def test_confidence_is_bounded() -> None:
    with pytest.raises(ValidationError):
        Action.model_validate(
            {
                "action": "none",
                "confidence": 1.5,
                "risk": "low",
                "explanation": "x",
                "reasoning_trace_id": "trace_1",
            }
        )
