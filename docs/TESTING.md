# PrivAgent Testing Plan

> **Status: PLANNED** — this document describes the intended design from
> `PrivAgent_Build_Specification.md`. It has not yet been verified against a working
> implementation. See the specification's Phase Gates for current build status.

Last updated: pre-implementation documentation scaffold.

The table copies the Build Specification's test criteria as planned acceptance evidence. Test files, commands, and actual results are `TBD` until implementation (see Build Spec §5).

| Task | Planned test criteria | Actual test file / command | Actual result |
|---|---|---|---|
| 0.1 | repo builds with a single command; folder structure matches plan. | TBD | TBD |
| 0.2 | extension loads unpacked in Chrome and in Firefox (about:debugging) with no console errors. | TBD | TBD |
| 0.3 | `lint` and `typecheck` scripts run clean on a fresh clone. | TBD | TBD |
| 0.4 | `curl /health` returns `200 {"status":"ok"}` locally and in Docker. | TBD | TBD |
| 0.5 | each script runs successfully from a clean checkout. | TBD | TBD |
| 1.1 | on a test form page, walker returns all inputs/buttons with correct bbox (±2px). | TBD | TBD |
| 1.2 | elements with only ARIA labels (no visible text) are still captured correctly. | TBD | TBD |
| 1.3 | output validates against the JSON schema on 5 different site types. | TBD | TBD |
| 1.4 | median extraction time < 50ms on a mid-tier laptop across the 5 test sites. | TBD | TBD |
| 2.1 | a sample model runs inference successfully on both backends; fallback triggers correctly when WebGPU is unavailable. | TBD | TBD |
| 2.2 | OCR correctly reads text from 10 sample canvas/image screenshots (≥85% character accuracy). | TBD | TBD |
| 2.3 | face detector correctly boxes faces in a labeled 20-image test set (≥90% recall). | TBD | TBD |
| 2.4 | fused output has no duplicate elements for the same on-screen region across 5 test pages. | TBD | TBD |
| 2.5 | median vision-pass latency and peak memory recorded; documented against the 20%-resource and 15%-latency targets. | TBD | TBD |
| 3.1 | 100% detection on a hand-built set of 30 structured PII samples, 0 false positives on 30 non-PII controls. | TBD | TBD |
| 3.2 | recall ≥ 90%, precision ≥ 85% on a labeled unstructured-text test set. | TBD | TBD |
| 3.3 | all faces flagged in Phase 2.3's test set are visibly masked in output screenshots. | TBD | TBD |
| 3.4 | tokenized output is reversible on-client only; server-bound payload contains zero raw values for all 3.1–3.3 test sets. | TBD | TBD |
| 3.5 | threshold tuned so borderline cases (confidence 0.4–0.6) are flagged, not silently passed through, on a 20-sample borderline set. | TBD | TBD |
| 4.1 | every clickable/fillable element in test pages receives a unique, stable mark id. | TBD | TBD |
| 4.2 | payload for a single-step task (e.g. "click download") excludes unrelated form fields present on the same page. | TBD | TBD |
| 4.3 | payload size reduced ≥ 70% vs. raw DOM dump, measured across 5 test pages. | TBD | TBD |
| 4.4 | manual spot-check of 20 serialized payloads confirms zero raw PII present. | TBD | TBD |
| 5.1 | endpoint accepts valid payloads (200) and rejects malformed ones (422) with clear errors. | TBD | TBD |
| 5.2 | end-to-end call from a sample sanitized payload returns a response within timeout. | TBD | TBD |
| 5.3 | 10 sample task payloads all produce schema-valid Action JSON (§4.2). | TBD | TBD |
| 5.4 | intentionally malformed model output is caught and retried/rejected, never forwarded to client. | TBD | TBD |
| 5.5 | median round-trip time recorded across 10 tasks; documented against the 15% latency target. | TBD | TBD |
| 6.1 | a labeled set of 15 sample actions (mix of low/medium/high risk) are scored consistently with expected risk tier. | TBD | TBD |
| 6.2 | high-risk actions (e.g. "submit payment") never auto-execute in test runs; confirmation UI appears every time. | TBD | TBD |
| 6.3 | all 4 action types execute correctly against 5 test pages with no misfires. | TBD | TBD |
| 6.4 | executor detects a stale `target_id` and re-perceives instead of clicking the wrong element, verified on a page with dynamic content. | TBD | TBD |
| 6.5 | all 5 tasks complete successfully end-to-end with correct final outcome. | TBD | TBD |
| 7.1 | log entries exist for Observe, Detect PII, Redact, Reason, Validate, Act stages on a sample task. | TBD | TBD |
| 7.2 | UI correctly renders the full trace for at least 3 completed tasks. | TBD | TBD |
| 7.3 | no missing pipeline stages across 5 different tasks' logs. | TBD | TBD |
| 7.4 | automated scan of log contents for regex-matchable PII patterns returns zero matches across all test runs so far. | TBD | TBD |
| 8.1 | dataset reviewed and versioned in `/tests/dataset`. | TBD | TBD |
| 8.2 | accuracy metric computed and documented in `results.md`. | TBD | TBD |
| 8.3 | recall/precision computed and documented; both above internally agreed minimum thresholds. | TBD | TBD |
| 8.4 | precision metric computed; zero unredacted critical fields (Aadhaar/bank/OTP/faces) across the dataset. | TBD | TBD |
| 8.5 | profiling data captured and documented for both tiers. | TBD | TBD |
| 8.6 | per-task latency breakdown (perceive/filter/reason/act) documented. | TBD | TBD |
| 8.7 | document exists and every rubric line item has a corresponding measured number. | TBD | TBD |
| 9.1 | both packages install and run correctly on a clean browser profile. | TBD | TBD |
| 9.2 | a teammate unfamiliar with the project can follow the README to run the full stack from scratch. | TBD | TBD |
| 9.3 | demo script rehearsed end-to-end without failure at least twice. | TBD | TBD |
| 9.4 | video covers the same 2–3 tasks and plays back correctly. | TBD | TBD |
| 9.5 | diagrams reviewed against the actual implemented system (no drift from what was built). | TBD | TBD |
| 9.6 | team can answer each of these three questions with a specific, implementation-grounded answer. | TBD | TBD |

## Planned suites

Vitest, Playwright, pytest, the dataset workflow, and benchmarking commands are planned but not yet created. Their exact invocation and result locations will be documented only after the relevant build tasks exist (see Build Spec §3, Phase 8).
