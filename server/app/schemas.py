from typing import Literal

from pydantic import BaseModel, Field


class ContextElement(BaseModel):
    markId: str = Field(pattern=r"^M\d+$")
    role: str
    text: str
    bbox: tuple[int, int, int, int]


class SanitizedContext(BaseModel):
    schemaVersion: Literal["1.0"]
    task: str = Field(min_length=1, max_length=500)
    elements: list[ContextElement]


class Action(BaseModel):
    action: Literal["click", "type", "scroll", "navigate", "none"]
    target_id: str | None = None
    params: dict[str, str] = {}
    confidence: float = Field(ge=0, le=1)
    explanation: str
