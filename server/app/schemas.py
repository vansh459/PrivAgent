"""Authoritative wire contract for PrivAgent.

These Pydantic models are the single source of truth for every payload that crosses
the client/server boundary. `scripts/gen-schemas.mjs` exports them to JSON Schema and
generates the client's TypeScript types and Zod validators, so the two sides cannot
drift. Field names are `snake_case` on the wire, matching Build Spec section 4.1-4.2.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = "1.0"

PiiType = Literal["AADHAAR", "PAN", "PHONE", "EMAIL", "CARD", "OTP", "NAME", "ADDRESS"]
"""PII classes the client Privacy Firewall can detect and tokenize.

The first six are structured: a pattern either matches or it does not. NAME and ADDRESS
are unstructured, recognised from context and word shape rather than from a format, and
they carry graded confidence - which is why the review band in `privacyDecision` exists.
"""

ElementSource = Literal["dom", "vision_ocr", "vision_face", "vision_object"]
"""Which local perception stage produced an element."""

RiskTier = Literal["low", "medium", "high"]
ActionType = Literal["click", "type", "scroll", "navigate", "none"]

BoundingBox = tuple[int, int, int, int]
"""Viewport-relative [x, y, width, height], in CSS pixels."""

Confidence = Annotated[float, Field(ge=0, le=1)]


class Strict(BaseModel):
    """Rejects unknown fields so an accidental raw-value leak cannot ride along."""

    model_config = ConfigDict(extra="forbid")


class ScreenStateElement(Strict):
    """One perceived on-screen element, before context building."""

    id: str = Field(min_length=1)
    role: str = Field(min_length=1)
    text: str
    bbox: BoundingBox
    source: ElementSource
    sensitive: bool
    aria_label: str | None = None
    pii_type: PiiType | None = None
    confidence: Confidence | None = None

    @model_validator(mode="after")
    def _vision_elements_carry_confidence(self) -> "ScreenStateElement":
        if self.source != "dom" and self.confidence is None:
            raise ValueError("vision-sourced elements must carry a confidence score")
        return self


class ScreenState(Strict):
    """The fused local view of the screen. Never transmitted; client-internal only."""

    schema_version: Literal["1.0"]
    elements: list[ScreenStateElement]
    task: str = Field(min_length=1, max_length=500)
    page_url_hash: str = Field(min_length=1)
    timestamp: str = Field(min_length=1)


class ContextElement(Strict):
    """A Set-of-Mark tagged element that is safe to transmit."""

    mark_id: str = Field(pattern=r"^M\d+$")
    role: str = Field(min_length=1)
    text: str
    bbox: BoundingBox


class SanitizedContext(Strict):
    """The only payload eligible to cross the network boundary."""

    schema_version: Literal["1.0"]
    task: str = Field(min_length=1, max_length=500)
    elements: list[ContextElement]


class Action(Strict):
    """The server's proposed next step, validated locally before execution."""

    action: ActionType
    target_id: str | None = None
    params: dict[str, str] = Field(default_factory=dict)
    confidence: Confidence
    risk: RiskTier
    explanation: str = Field(min_length=1)
    reasoning_trace_id: str = Field(min_length=1)

    @model_validator(mode="after")
    def _targeted_actions_name_a_mark(self) -> "Action":
        if self.action in {"click", "type"} and not self.target_id:
            raise ValueError(f"a {self.action} action must name a target_id")
        return self


EXPORTED_MODELS: dict[str, type[BaseModel]] = {
    "ScreenStateElement": ScreenStateElement,
    "ScreenState": ScreenState,
    "ContextElement": ContextElement,
    "SanitizedContext": SanitizedContext,
    "Action": Action,
}
