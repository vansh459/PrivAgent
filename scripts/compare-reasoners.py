"""Scores candidate local models on the same ten task payloads, and prints a table.

Model choice for this project is a real decision with a measurable answer, and the build
spec asks for the specific model to be named. This is what named it: same prompt, same
screens, same expectations, one row per model. Run it with any Ollama model installed:

    python scripts/compare-reasoners.py llama3.2:1b qwen2.5:1.5b

Expectations are recorded as a set of acceptable mark ids, or `none` where the honest
answer is that nothing on the screen serves the task. A model that clicks something for a
task the screen cannot satisfy is worse than one that declines, so those cases carry the
same weight as the positive ones.
"""

from __future__ import annotations

import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from app.ollama import OllamaProvider  # noqa: E402
from app.schemas import SanitizedContext  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server" / "tests"))

from reasoner_cases import CASES  # noqa: E402


def outcome(action) -> str:
    if action.action == "none":
        return "none"
    return f"{action.action}:{action.target_id}"


def run(model: str) -> None:
    provider = OllamaProvider(model=model)
    correct = 0
    schema_valid = 0
    latencies: list[float] = []

    print(f"\n=== {model}")
    for task, elements, acceptable in CASES:
        context = SanitizedContext.model_validate(
            {"schema_version": "1.0", "task": task, "elements": elements}
        )
        started = time.time()
        action = provider.reason(context)
        millis = (time.time() - started) * 1000
        latencies.append(millis)

        # Every answer that reaches here is schema-valid by construction: the provider
        # refuses to forward anything else. What varies is whether it is *right*.
        usable = not action.explanation.startswith("The local model did not return")
        schema_valid += int(usable)
        hit = outcome(action) in acceptable
        correct += int(hit)
        print(
            f"  {'OK ' if hit else 'MISS'} {millis:7.0f}ms {task!r:28} -> "
            f"{outcome(action):10} risk={action.risk:6} conf={action.confidence}"
        )

    print(
        f"  correct {correct}/{len(CASES)}, usable answers {schema_valid}/{len(CASES)}, "
        f"median {statistics.median(latencies):.0f} ms, "
        f"max {max(latencies):.0f} ms"
    )


if __name__ == "__main__":
    for candidate in sys.argv[1:] or ["llama3.2:1b"]:
        run(candidate)
