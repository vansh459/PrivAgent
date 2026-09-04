# PrivAgent Architecture

> **Status: PLANNED** — this document describes the intended design from
> `PrivAgent_Build_Specification.md`. It has not yet been verified against a working
> implementation. See the specification's Phase Gates for current build status.

Last updated: pre-implementation documentation scaffold.

This is the intended technical architecture and privacy boundary (see Build Spec §2).

```text
┌───────────────────────────────── BROWSER (CLIENT) ─────────────────────────────────┐
│                                                                                      │
│  ┌────────────────┐     ┌───────────────────┐                                      │
│  │ Content Script  │────▶│ DOM / A11y Walker  │──┐                                  │
│  └────────────────┘     └───────────────────┘  │                                  │
│                                                   ▼                                  │
│  ┌────────────────┐     ┌───────────────────┐  ┌─────────────────────┐            │
│  │ Screenshot Cap  │────▶│ Local Vision Model │──▶│  Fusion Engine       │            │
│  │ (canvas/tab)    │     │ (ONNX + WebGPU)    │  │  (DOM + Vision ⇒     │            │
│  └────────────────┘     └───────────────────┘  │  unified Screen       │            │
│                                                   │  State JSON)         │            │
│                                                   └──────────┬──────────┘            │
│                                                              ▼                       │
│                                                   ┌─────────────────────┐            │
│                                                   │  Privacy Firewall    │            │
│                                                   │  · regex + NER PII   │            │
│                                                   │  · face/pixel redact │            │
│                                                   │  · confidence gate   │            │
│                                                   └──────────┬──────────┘            │
│                                                              ▼                       │
│                                                   ┌─────────────────────┐            │
│                                                   │  Context Builder     │            │
│                                                   │  Set-of-Mark tagging │            │
│                                                   │  + compact JSON      │            │
│                                                   └──────────┬──────────┘            │
└──────────────────────────────────────────────────────────────┼──────────────────────┘
                                                                 │ HTTPS
                                                                 │ (sanitized payload only)
                                                                 ▼
┌───────────────────────────────── SERVER (BACKEND) ──────────────────────────────────┐
│  ┌─────────────────────┐     ┌─────────────────────┐     ┌──────────────────────┐   │
│  │ FastAPI /reason      │────▶│  LLM / VLM Reasoner  │────▶│ Structured Action     │   │
│  │ endpoint             │     │  (open-weight model) │     │ JSON {action, target, │   │
│  └─────────────────────┘     └─────────────────────┘     │ params, confidence}   │   │
│                                                             └──────────────────────┘   │
└──────────────────────────────────────────────────────────────┼──────────────────────┘
                                                                 │ HTTPS response
                                                                 ▼
┌───────────────────────────────── BROWSER (CLIENT) ─────────────────────────────────┐
│  ┌─────────────────────┐     ┌─────────────────────┐     ┌──────────────────────┐   │
│  │ Risk & Confidence    │────▶│  Action Executor      │────▶│ Audit Trail Logger    │   │
│  │ Validator (local)    │     │  (click/type/scroll)  │     │ (local IndexedDB)     │   │
│  └─────────────────────┘     └─────────────────────┘     └──────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Responsibilities

| Component | Intended responsibility | Planned location | Implementation notes |
|---|---|---|---|
| Content Script | Orchestrate extraction, redaction, and actions | `extension/src/content/` | TBD once built |
| DOM / A11y Walker | Collect role, label, text, and bounding box | `extension/src/content/` | TBD once built |
| Screenshot Capture | Capture visible visual regions | `extension/src/content/` | TBD once built |
| Local Vision Model | OCR and face/object detection | `extension/src/models/` | TBD once built |
| Fusion Engine | Merge DOM and vision Screen State JSON | `extension/src/content/` | TBD once built |
| Privacy Firewall | Detect, mask, and tokenize sensitive content | `extension/src/content/` | TBD once built |
| Context Builder | Create minimal Set-of-Mark JSON | `extension/src/content/` | TBD once built |
| Backend API | Accept context and return validated actions | `server/app/main.py` | TBD once built |
| LLM / VLM Reasoner | Interpret sanitized context | `server/app/reasoning.py` | TBD model and host |
| Risk Validator | Gate returned actions by risk and confidence | `extension/src/content/` | TBD once built |
| Action Executor | Resolve a target ID and act on live DOM | `extension/src/content/` | TBD once built |
| Audit Trail | Store stage decisions in IndexedDB | `extension/src/ui/` / client | TBD once built |

## Privacy boundary

Raw screen imagery, DOM content, raw PII, client token maps, and local audit records are designed to remain in the browser. Only Privacy Firewall-sanitized, task-relevant structured context is intended to cross HTTPS to `/reason`; returned actions are designed to be validated locally before execution (see Build Spec §2, §4).

## Intended sequence

A real audit-log trace is not available before Phase 7. The planned sequence is: user task → local perception → fusion → Privacy Firewall → Context Builder → `/reason` → local validation → Action Executor → local Audit Trail (see Build Spec §4). Replace this section with a captured trace after Phase 7 closes.
