"""Authoritative wire contract for PrivAgent.

These Pydantic models are the single source of truth for every payload that crosses
the client/server boundary. `scripts/gen-schemas.mjs` exports them to JSON Schema and
generates the client's TypeScript types and Zod validators, so the two sides cannot
drift. Field names are `snake_case` on the wire, matching Build Spec section 4.1-4.2.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = "1.1"

SCHEMA_VERSIONS = ("1.0", "1.1")
"""Both accepted on the wire during the transition.

1.0 is the single-shot contract; 1.1 adds the multi-step vocabulary (`done`/`blocked`
actions, optional `step` and `history` on the context). A 1.0 payload is a valid 1.1
payload with the optional fields absent, so old clients keep working unchanged.
"""

PiiType = Literal["AADHAAR", "PAN", "PHONE", "EMAIL", "CARD", "OTP", "NAME", "ADDRESS"]
"""PII classes the client Privacy Firewall can detect and tokenize.

The first six are structured: a pattern either matches or it does not. NAME and ADDRESS
are unstructured, recognised from context and word shape rather than from a format, and
they carry graded confidence - which is why the review band in `privacyDecision` exists.
"""

ElementSource = Literal["dom", "vision_ocr", "vision_face", "vision_object"]
"""Which local perception stage produced an element."""

RiskTier = Literal["low", "medium", "high"]
ActionType = Literal["click", "type", "scroll", "navigate", "none", "done", "blocked"]
"""`done` and `blocked` are terminal: the multi-step loop ends on either.

`done` carries a short result summary in `params["summary"]`. `blocked` carries the
reason in `params["reason"]` - and `bot_detection` is a hard stop by policy: the agent
detects automation challenges and stops; it never attempts to defeat one.
"""

BlockedReason = Literal["bot_detection", "login_required", "cannot_proceed"]
BLOCKED_REASONS = ("bot_detection", "login_required", "cannot_proceed")

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


class StepInfo(Strict):
    """Where the multi-step loop is: step `n` of at most `limit`."""

    n: int = Field(ge=1, le=50)
    limit: int = Field(ge=1, le=50)


class HistoryStep(Strict):
    """One compact prior step, so the reasoner can plan without re-deriving the past.

    `page_ident` is the page's *redacted title* - it has been through the same Privacy
    Firewall as every element text. It is never a URL, not even hashed: URLs are on the
    never-transmitted list in docs/SECURITY.md and stay there in 1.1.
    """

    action: ActionType
    target_role: str | None = None
    outcome: str = Field(min_length=1, max_length=120)
    page_ident: str = Field(max_length=120)


class SanitizedContext(Strict):
    """The only payload eligible to cross the network boundary."""

    schema_version: Literal["1.0", "1.1"]
    task: str = Field(min_length=1, max_length=500)
    elements: list[ContextElement]
    # 1.1, optional: absent on single-shot payloads, so every 1.0 payload stays valid.
    step: StepInfo | None = None
    history: list[HistoryStep] = Field(default_factory=list, max_length=15)
    # The CURRENT page's redacted title - same firewall and same privacy budget as a
    # history entry's page_ident, never a URL. Without it the reasoner cannot tell
    # whether a prior navigation reached the intended page: observed live, the model
    # kept acting on a goal that was already met because nothing said where it was.
    page_ident: str | None = Field(default=None, max_length=120)


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
        if self.action == "blocked" and self.params.get("reason") not in BLOCKED_REASONS:
            raise ValueError(
                f"a blocked action must carry params.reason, one of {', '.join(BLOCKED_REASONS)}"
            )
        return self


EXPORTED_MODELS: dict[str, type[BaseModel]] = {
    "ScreenStateElement": ScreenStateElement,
    "ScreenState": ScreenState,
    "ContextElement": ContextElement,
    "StepInfo": StepInfo,
    "HistoryStep": HistoryStep,
    "SanitizedContext": SanitizedContext,
    "Action": Action,
}
