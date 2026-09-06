"""Offline evaluation of NER-verifier candidates for the NAME precision gap (B1).

The rule-based NAME detector recalls 397/397 labelled spans but produces 133 distinct
false positives (212 detections) across the 42-page dataset, holding overall PII
precision at ~70%. The plan is a hybrid: keep the rules for recall, then run a small
quantized token-classification model ONLY over rule-candidate spans and drop candidates
the model does not confirm as a person.

This script answers, before any extension code is written: which candidate model, and
at what threshold, rejects enough false positives while keeping every true name?

Case sets (all derived from the repo's own reviewed data):
  A. must-REJECT — pii-review.json NAME entries with verdict=false_positive,
     with detection context joined from test-results/pii-unlabelled.json.
  B. must-KEEP  — pii-review.json NAME entries with verdict=real.
  C. must-KEEP  — every labelled NAME span in tests/dataset/screens/*.json
     (these are the recall 397/397 spans; losing any one is disqualifying).

Decision rule evaluated (mirrors the planned TS implementation): encode a text window
around the candidate, run the model, and confirm the candidate iff any PER-class token
overlapping the candidate span scores >= threshold.

Usage: python scripts/eval-ner-verifier.py
Models are expected under %TEMP%/privagent-ner/{tinybert,distilbert}/.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = Path(os.environ.get("TEMP", "/tmp")) / "privagent-ner"
WINDOW = 200  # chars of context kept on each side of the candidate


def softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - x.max(axis=-1, keepdims=True))
    return e / e.sum(axis=-1, keepdims=True)


class NerModel:
    def __init__(self, name: str, directory: Path) -> None:
        self.name = name
        self.session = ort.InferenceSession(
            str(directory / "model_quantized.onnx"), providers=["CPUExecutionProvider"]
        )
        self.input_names = [i.name for i in self.session.get_inputs()]
        self.tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=512)
        config = json.loads((directory / "config.json").read_text(encoding="utf8"))
        self.id2label = {int(k): v for k, v in config["id2label"].items()}
        if all(v.startswith("LABEL_") for v in self.id2label.values()):
            # TinyBERT-finetuned-NER-ONNX ships an unmapped config; probing with known
            # sentences shows it uses the standard CoNLL-2003 order (same as distilbert).
            conll = ["O", "B-PER", "I-PER", "B-ORG", "I-ORG", "B-LOC", "I-LOC", "B-MISC", "I-MISC"]
            self.id2label = dict(enumerate(conll))
        self.size_mb = (directory / "model_quantized.onnx").stat().st_size / 1e6

    def per_score_over(self, text: str, start: int, end: int) -> float:
        """Max probability of any PER-class token overlapping [start, end)."""
        enc = self.tokenizer.encode(text)
        feeds = {
            "input_ids": np.array([enc.ids], dtype=np.int64),
            "attention_mask": np.array([enc.attention_mask], dtype=np.int64),
        }
        if "token_type_ids" in self.input_names:
            feeds["token_type_ids"] = np.array([enc.type_ids], dtype=np.int64)
        logits = self.session.run(None, feeds)[0][0]
        probs = softmax(logits)
        best = 0.0
        for idx, (tok_start, tok_end) in enumerate(enc.offsets):
            if tok_end <= tok_start:  # special tokens
                continue
            if tok_start >= end or tok_end <= start:  # no overlap with candidate
                continue
            for label_id, label in self.id2label.items():
                if label.endswith("PER"):
                    best = max(best, float(probs[idx][label_id]))
        return best


def windowed(text: str, value: str) -> tuple[str, int, int] | None:
    """Locate value in text and trim to a WINDOW-char context around it."""
    at = text.find(value)
    if at < 0:
        return None
    lo = max(0, at - WINDOW)
    hi = min(len(text), at + len(value) + WINDOW)
    return text[lo:hi], at - lo, at - lo + len(value)


def load_cases() -> dict[str, list[tuple[str, int, int, str]]]:
    review = json.loads((ROOT / "tests/dataset/pii-review.json").read_text(encoding="utf8"))
    unlabelled = json.loads(
        (ROOT / "test-results/pii-unlabelled.json").read_text(encoding="utf8")
    )
    # Context per (type, value): the detection rows from the last eval run.
    context: dict[tuple[str, str], str] = {}
    for row in unlabelled["rows"]:
        context.setdefault((row["type"], row["value"]), row["text"])

    reject: list[tuple[str, int, int, str]] = []
    keep_real: list[tuple[str, int, int, str]] = []
    for entry in review["entries"]:
        if entry["type"] != "NAME":
            continue
        value = entry["value"]
        ctx = context.get(("NAME", value))
        located = windowed(ctx, value) if ctx else None
        if located is None:
            # Context truncated past the value, or detector output drifted: score the
            # bare value. Same fallback the runtime verifier will use.
            located = (value, 0, len(value))
        case = (*located, value)
        if entry["verdict"] == "false_positive":
            reject.append(case)
        elif entry["verdict"] == "real":
            keep_real.append(case)

    keep_labelled: list[tuple[str, int, int, str]] = []
    screens_dir = ROOT / "tests/dataset/screens"
    for path in sorted(screens_dir.glob("*.json")):
        if path.name in ("sources.json", "index.json"):
            continue
        screen = json.loads(path.read_text(encoding="utf8"))
        texts = {row["truthId"]: row["text"] for row in screen["texts"] if row.get("truthId")}
        for span in screen["pii"]:
            if span["type"] != "NAME":
                continue
            text = texts.get(span["id"])
            if text is None:
                continue
            located = windowed(text, span["value"])
            if located is None:
                located = (span["value"], 0, len(span["value"]))
            keep_labelled.append((*located, span["value"]))

    return {"reject": reject, "keep_real": keep_real, "keep_labelled": keep_labelled}


def main() -> None:
    cases = load_cases()
    print(
        f"cases: reject={len(cases['reject'])} keep_real={len(cases['keep_real'])} "
        f"keep_labelled={len(cases['keep_labelled'])}\n"
    )

    results = {}
    for name in ("tinybert", "distilbert"):
        directory = MODELS_DIR / name
        if not directory.exists():
            print(f"-- {name}: not found at {directory}, skipping")
            continue
        model = NerModel(name, directory)
        scores: dict[str, list[tuple[float, str]]] = {}
        t0 = time.perf_counter()
        n = 0
        for group, rows in cases.items():
            scores[group] = []
            for text, start, end, value in rows:
                scores[group].append((model.per_score_over(text, start, end), value))
                n += 1
        ms_per = (time.perf_counter() - t0) * 1000 / max(n, 1)

        print(f"== {model.name}  ({model.size_mb:.1f} MB, {ms_per:.0f} ms/candidate CPU)")
        model_result = {"size_mb": model.size_mb, "ms_per_candidate": ms_per, "thresholds": {}}
        for threshold in (0.3, 0.5, 0.7, 0.9):
            rejected = sum(1 for s, _ in scores["reject"] if s < threshold)
            kept_real = sum(1 for s, _ in scores["keep_real"] if s >= threshold)
            kept_lab = sum(1 for s, _ in scores["keep_labelled"] if s >= threshold)
            lost = [v for s, v in scores["keep_labelled"] if s < threshold]
            print(
                f"  t={threshold:.1f}  FP rejected {rejected}/{len(scores['reject'])}"
                f"  real kept {kept_real}/{len(scores['keep_real'])}"
                f"  labelled kept {kept_lab}/{len(scores['keep_labelled'])}"
                + (f"  LOST: {lost[:4]}" if lost else "")
            )
            model_result["thresholds"][threshold] = {
                "fp_rejected": rejected,
                "fp_total": len(scores["reject"]),
                "real_kept": kept_real,
                "real_total": len(scores["keep_real"]),
                "labelled_kept": kept_lab,
                "labelled_total": len(scores["keep_labelled"]),
                "labelled_lost_examples": lost[:10],
            }
        # The candidates every threshold got wrong, for reading.
        model_result["never_rejected_fps"] = [
            v for s, v in scores["reject"] if s >= 0.9
        ][:15]
        results[name] = model_result
        print()

    out = ROOT / "test-results" / "ner-verifier-eval.json"
    out.write_text(json.dumps(results, indent=2) + "\n", encoding="utf8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
