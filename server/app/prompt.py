"""The system prompt, versioned, and the shape the model is required to answer in.

Versioned because a prompt is part of the contract with the model in the same way the
schema is part of the contract with the client: changing it changes behaviour, and a
result that cannot be traced to the prompt that produced it cannot be reproduced. The
version travels in the reasoning trace id, so any recorded action can be tied back to the
exact wording that produced it.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .schemas import ActionType, Confidence, RiskTier

SYSTEM_PROMPT_VERSION = "1.1"

PROMPT_CHANGELOG = {
    "1.0": "First version. Rules only, no examples.",
    "1.1": (
        "Added the explicit 'does the element's text plainly match' check, confidence "
        "calibration guidance, and one worked example - of *declining*. Measured on ten "
        "payloads with qwen2.5:1.5b: 1.0 scored 7/10 and answered every task at "
        "confidence 1.0; this version scores 8/10 with calibrated confidences. "
        "Two variants were measured and rejected on the way: adding a worked example of "
        "a successful click dropped the score to 5/10, because the model copied the "
        "example's mark id into unrelated answers, and elaborating the risk rules with "
        "concrete phrases dropped it to 7/10. Both are recorded because 'we tried the "
        "obvious improvement and it was worse' is the useful half of prompt work."
    ),
}

SYSTEM_PROMPT = """You choose the next single UI action for a browser agent.

You are given a task and a list of on-screen elements. Each element has a mark id (M1,
M2, ...), a role, its visible text and its position. This is everything you get: you
cannot see the page, and you cannot ask for more.

Rules:
1. Choose exactly one action: click, type, scroll, navigate, or none.
2. target_id must be one of the mark ids given to you, copied exactly. Never invent one.
   Use null for scroll, navigate and none.
3. For "type", put the text to enter in params as {"text": "..."}.
4. Before choosing click or type, check that the element's own text plainly matches what
   the task asks for. If nothing on the list does, answer "none". Do not settle for the
   first element, or the only button, or something merely related. A wrong click is worse
   than no click: the user can repeat a task, but cannot undo an action they never asked
   for.
5. Some text has been replaced with tokens like [PII_NAME_01] or [PII_PHONE_02]. That is
   private data the user's device withheld. Treat a token as an opaque label: it is fine
   to click an element containing one, but never guess what it stands for and never
   include a token's meaning in your explanation.
6. confidence: 0.9 or above only when the element's text is an unambiguous match for the
   task; 0.5 to 0.8 when it is a reasonable inference; below 0.5 means you are guessing,
   and you should answer "none" instead.
7. risk: "low" for reading or navigating within a page, "medium" for entering data,
   "high" for anything that submits, pays, deletes, sends or leaves the page. When in
   doubt, choose the higher tier. The client raises risk it disagrees with but never
   lowers it.
8. explanation is one short sentence, for the user, saying what you are about to do and
   why. It is shown to them before anything happens.

Worked example of declining. Task: "delete my account". Elements: M6 [link] 'Download
report', M7 [button] 'Submit payment'. Neither element deletes an account, so the answer
is {"action":"none","target_id":null,"params":{},"confidence":0.0,"risk":"low",
"explanation":"Nothing on this screen deletes an account."} - not a click on M7 because
it is the only button.

Answer with JSON only, matching the required shape."""


class ModelAction(BaseModel):
    """What the model itself is asked to produce.

    Deliberately smaller than `Action`: the reasoning trace id is assigned by the server,
    not invented by the model, so that it can identify the prompt version and the request
    rather than being a string the model made up.
    """

    model_config = ConfigDict(extra="forbid")

    # Every field is required, with no defaults. Optional fields are the difference
    # between a schema the decoder *enforces* and one it merely permits: with
    # `target_id` optional, a constrained model answered {"action":"click"} with no
    # target at all, which the semantic check then had to reject on every attempt. Made
    # required, the same model names the mark.
    action: ActionType
    target_id: str | None
    params: dict[str, str]
    confidence: Confidence
    risk: RiskTier
    explanation: str = Field(min_length=1)


def render_context(task: str, elements: list[dict[str, object]]) -> str:
    """Renders the sanitized context as the user turn.

    Compact on purpose. Every token spent restating the schema is latency, and small
    models follow a short concrete listing better than they follow prose.
    """
    lines = [f"Task: {task}", "", "Elements:"]
    for element in elements:
        text = str(element.get("text", "")).strip()
        lines.append(
            f"- {element['mark_id']} [{element['role']}] {text!r} at {element['bbox']}"
        )
    if not elements:
        lines.append("- (none visible)")
    lines.append("")
    lines.append("Answer with the JSON action.")
    return "\n".join(lines)


def response_format() -> dict[str, object]:
    """The JSON schema handed to the runtime so decoding is constrained to valid shapes.

    Structured output is what makes a 1B model usable here: unconstrained, small models
    emit prose around their JSON, or invent fields. Constrained, the only remaining
    failure modes are semantic - a hallucinated mark id, or a nonsensical choice - which
    is what the validation in `reasoning.py` exists to catch.
    """
    return ModelAction.model_json_schema()


ProviderName = Literal["deterministic", "ollama"]
