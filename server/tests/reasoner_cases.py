"""The ten task payloads every reasoner is scored on.

One list, used by both the model comparison script and the live test, because ground
truth that exists in two places drifts into two different truths. Each case records the
answers that would be acceptable; `none` means the screen genuinely cannot serve the task
and declining is the right answer. Those cases carry the same weight as the positive ones:
a model that acts on a task the screen cannot satisfy is more dangerous than one that
declines a task it could have done.
"""

from __future__ import annotations

PORTAL = [
    {"mark_id": "M1", "role": "link", "text": "Download report", "bbox": [10, 10, 120, 20]},
    {"mark_id": "M2", "role": "button", "text": "Cancel", "bbox": [10, 40, 80, 20]},
    {"mark_id": "M3", "role": "text_field", "text": "Search invoices", "bbox": [10, 70, 200, 24]},
    {"mark_id": "M4", "role": "button", "text": "Submit payment", "bbox": [10, 110, 140, 28]},
]

CLAIMS = [
    {"mark_id": "M1", "role": "link", "text": "Approve claim", "bbox": [10, 10, 120, 20]},
    {"mark_id": "M2", "role": "button", "text": "Reject claim", "bbox": [140, 10, 120, 20]},
    {"mark_id": "M3", "role": "canvas", "text": "Settlement total 84,200", "bbox": [10, 40, 420, 180]},
]

FORM = [
    {"mark_id": "M1", "role": "text_field", "text": "Full name", "bbox": [10, 10, 200, 24]},
    {"mark_id": "M2", "role": "text_field", "text": "Email address", "bbox": [10, 40, 200, 24]},
    {"mark_id": "M3", "role": "button", "text": "Continue", "bbox": [10, 80, 100, 28]},
    {"mark_id": "M4", "role": "note", "text": "Registered to [PII_NAME_01]", "bbox": [10, 120, 300, 20]},
]

# (task, elements, acceptable actions). "none" means declining is the right answer.
CASES: list[tuple[str, list[dict[str, object]], set[str]]] = [
    ("download the report", PORTAL, {"click:M1"}),
    ("cancel this", PORTAL, {"click:M2"}),
    ("pay the bill", PORTAL, {"click:M4"}),
    ("open the settings menu", PORTAL, {"none"}),
    ("delete my account", PORTAL, {"none"}),
    ("approve the claim", CLAIMS, {"click:M1"}),
    ("reject the claim", CLAIMS, {"click:M2"}),
    ("print this page", CLAIMS, {"none"}),
    ("continue to the next step", FORM, {"click:M3"}),
    ("enter my email address", FORM, {"type:M2"}),
]


