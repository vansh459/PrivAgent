# PrivAgent — Complete Build Specification & Phased Execution Prompt
### On-device Visual Perception for Lightweight Browser Agents (SIH26171)

---

## 0. Purpose of This Document

This is a master build specification **and** an execution prompt. It is meant to be
followed literally — by a human dev team, or handed to an AI coding agent (e.g. Claude
Code) — phase by phase, task by task, with **no task skipped and no phase started early**.

### 0.1 Execution Rules (read first, follow always)

For **every task** in every phase below:

1. **Implement** the task exactly as scoped.
2. **Write and run the test(s)** listed under that task's "Test Criteria."
3. **Only if the test passes**, change the checkbox from `[ ]` to `[x]`.
4. Immediately after checking a box, fill in the **Notes** line under that task with:
   `date completed · what was tested · result/metric observed · any caveat`.
5. If a test **fails**, leave the checkbox as `[ ]`, write the blocker in Notes, fix the
   issue, and re-test. Do **not** move to the next task.
6. Do **not** begin the next task until the current task's box is checked.
7. Do **not** begin the next phase until **every** task in the current phase is checked
   and every Notes line is filled in. This is the **Phase Gate**.
8. If a phase's Phase Gate cannot be closed (something is fundamentally blocked), stop
   and re-scope rather than silently skipping ahead — leave the box empty, it is a
   signal, not a failure.

An empty box (`[ ]`) always means "not done." A checked box (`[x]`) always means
"built and tested," never "attempted."

---

## 1. Problem Statement Recap

- **Ask:** a browser-based agent that visually perceives the screen client-side, redacts
  sensitive/PII data locally, sends only a sanitized structured context to a
  server-side LLM/VLM, and executes the returned action locally.
- **Required client components:** local vision model (ViT/CV, via WebGPU) evaluating
  screen state; privacy-preserving filter (bounding-box redaction, masking, semantic
  obfuscation).
- **Required server components:** an offline-deployable open-weight LLM/VLM that
  interprets sanitized context and returns either processed data or a UI action.
- **Browsers targeted:** Chrome and Firefox.

### 1.1 Evaluation Weights (design every phase around these)

| Criterion | Weight |
|---|---|
| Accuracy of visual context from screen | **25%** |
| Recall & precision of PII/sensitive-data detection | 20% |
| Precision of redaction | 20% |
| Client-side resource utilization | 20% |
| End-to-end latency | 15% |

**Design implication:** visual context accuracy is the single largest line item. The
build plan below therefore treats **local vision** as a first-class, always-present
pipeline stage — DOM/Accessibility extraction is an *optimization on top of* vision,
not a replacement for it. This corrects a common failure mode where DOM-only
extraction is presented as "visual perception" and scores poorly on the 25% line.

---

## 2. System Architecture

```
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

### 2.1 Component Responsibilities

| Component | Responsibility | Runs where |
|---|---|---|
| Content Script | Injected per tab; orchestrates extraction, redaction, action execution | Client |
| DOM/A11y Walker | Extracts structured elements: role, label, text, bounding box | Client |
| Screenshot Capture | Grabs visible tab / canvas region for vision model input | Client |
| Local Vision Model | Runs OCR + object/face detection on screenshot regions DOM cannot represent (canvas, video, images, iframes) | Client (WebGPU/WASM) |
| Fusion Engine | Merges DOM output + vision output into one Screen State JSON, resolving overlaps | Client |
| Privacy Firewall | Detects PII (regex + local NER) and sensitive visual regions (faces, ID photos); redacts/tokenizes/masks | Client |
| Context Builder | Applies Set-of-Mark tagging, strips anything not task-relevant, serializes compact JSON | Client |
| Backend API | Receives sanitized context, orchestrates LLM/VLM call, validates response schema | Server |
| LLM/VLM Reasoner | Interprets sanitized context, decides next action or returns processed data | Server |
| Risk & Confidence Validator | Scores returned action by risk + confidence; blocks/asks-confirmation on high risk | Client |
| Action Executor | Executes click/type/scroll/navigate against real DOM refs | Client |
| Audit Trail Logger | Records every pipeline stage's decision locally, never transmits raw PII | Client |

---

## 3. Technology Stack (with justification)

| Layer | Choice | Why |
|---|---|---|
| Extension manifest | Manifest V3 | Required by Chrome; Firefox now supports MV3 |
| Cross-browser layer | `webextension-polyfill` | One codebase for Chrome + Firefox, satisfies PS requirement |
| Extension build tooling | Vite + CRXJS plugin | Fast HMR for extension dev, first-class MV3 support |
| Extension language | TypeScript | Type safety for a multi-stage pipeline with strict JSON schemas |
| Extension UI (popup/side panel) | React + Tailwind | Fast to build the audit-trace and confirmation UI |
| Local ML runtime | ONNX Runtime Web (WebGPU backend, WASM fallback) | Best-supported path for running quantized vision/NER models client-side today |
| OCR model | Tesseract.js (WASM) or a distilled OCR ONNX model | Reads on-screen text from canvas/image regions DOM can't expose |
| Local vision/object model | Quantized MobileViT / TinyViT or a small YOLO variant (ONNX) | Lightweight enough for WebGPU inference at interactive latency |
| Local face detection | BlazeFace (ONNX/TF.js) | Small, fast, purpose-built for face bounding boxes → redaction |
| Local PII/NER model | Distilled BERT-based PII NER, quantized, via Transformers.js/ONNX | Catches unstructured PII (names, addresses) regex can't |
| Structured PII detection | Regex library (Aadhaar, PAN, phone, email, card, OTP patterns) | Cheap, high-precision for structured formats |
| Redaction | Canvas pixel masking (images/faces) + DOM text tokenization (`[PII_PHONE_01]`) | Matches PS's "bounding-box redaction / masking / semantic obfuscation" requirement |
| Context format | JSON + Set-of-Mark element tagging | Grounding technique from referenced literature; keeps payload compact and machine-actionable |
| Backend framework | FastAPI (Python) | Best ecosystem fit for ML/LLM orchestration, async, easy to containerize |
| Server LLM/VLM | Open-weight VLM, e.g. Qwen2-VL or LLaVA-NeXT for offline deployability; cloud-hosted equivalent during SIH for demo speed | Satisfies "must be offline-deployable, cloud OK during SIH" constraint |
| Local audit storage | IndexedDB | Persistent, local-only, no server round-trip for logs |
| Testing (extension) | Vitest (unit), Playwright (E2E browser automation) | Playwright can drive a real loaded extension in Chrome/Firefox |
| Testing (backend) | pytest | Standard, integrates with FastAPI's TestClient |
| Benchmarking | Custom latency harness + Chrome DevTools Performance/Memory panel | Needed for the 20% resource + 15% latency rubric lines |
| Packaging | `web-ext` (Firefox) + Chrome Web Store packer | Cross-browser distributable builds |

---

## 4. End-to-End Workflow

1. **Trigger:** user issues a task (e.g. "download the sanctioned expenditure report").
2. **Perceive locally:** content script captures DOM/A11y tree **and** a screenshot;
   local vision model runs OCR + object/face detection on regions DOM can't cover.
3. **Fuse:** DOM output and vision output merge into one Screen State JSON — every
   element gets an id, role, text, bbox, and a `sensitive: bool` placeholder.
4. **Filter locally (Privacy Firewall):** regex + local NER scan all text fields;
   vision-detected faces/ID-like regions get pixel-masked; every sensitive field is
   replaced with a stable placeholder token before anything is serialized further.
5. **Build safe context:** Context Builder strips anything not relevant to the current
   task, applies Set-of-Mark tags to remaining interactive elements, compacts to JSON.
6. **Reason remotely:** sanitized JSON is sent over HTTPS to the backend; the LLM/VLM
   interprets it and returns a structured action (`{action, target_id, params,
   confidence}`) or processed data.
7. **Validate locally:** Risk & Confidence Validator scores the returned action; low
   risk + high confidence auto-proceeds, medium/high risk pauses for user confirmation.
8. **Act locally:** Action Executor performs the click/type/scroll/navigate against the
   real DOM element referenced by its Screen State id (never against raw coordinates
   from the server, to avoid stale-target errors).
9. **Log:** every stage's decision (what was observed, what was detected as sensitive,
   what was redacted, what was reasoned, what was validated, what was executed) is
   written to the local audit trail.
10. **Repeat** steps 2–9 until task completion or user cancellation.

### 4.1 Screen State JSON (schema sketch)

```json
{
  "elements": [
    {
      "id": "el_07",
      "role": "button",
      "text": "Download Report",
      "bbox": [820, 640, 160, 40],
      "source": "dom",
      "sensitive": false
    },
    {
      "id": "el_12",
      "role": "text_field",
      "text": "[PII_PHONE_01]",
      "bbox": [400, 300, 220, 28],
      "source": "vision_ocr",
      "sensitive": true,
      "pii_type": "phone"
    }
  ],
  "task": "download sanctioned expenditure report",
  "page_url_hash": "sha256:...",
  "timestamp": "2026-09-04T10:00:00Z"
}
```

### 4.2 Action JSON (server → client)

```json
{
  "action": "click",
  "target_id": "el_07",
  "params": {},
  "confidence": 0.96,
  "risk": "low",
  "reasoning_trace_id": "trace_881"
}
```

---

## 5. Build Phases

> Reminder: complete every task in a phase, check its box, fill its Notes, **then and
> only then** move to the next phase.

---

### Phase 0 — Project Setup & Environment
**Objective:** working skeleton for extension + backend, loadable in both browsers.

- [x] **0.1** Initialize monorepo: `/extension`, `/server`, `/docs`, `/tests`.
  - Test criteria: repo builds with a single command; folder structure matches plan.
  - Notes: 2026-09-04 · ran `npm run build` and checked required directories · structure validator passed and all four directories exist · build currently validates the Phase 0.1 skeleton only; extension and server builds will be added by later tasks.
- [x] **0.2** Scaffold extension with Vite + CRXJS, Manifest V3, TypeScript, `webextension-polyfill`.
  - Test criteria: extension loads unpacked in Chrome with no console errors (Firefox verification deferred by user direction).
  - Notes: 2026-09-04 · ran `npm run build --prefix extension`, then launched Chrome headless with `--load-extension=extension/dist` and `--dump-dom about:blank` · build passed and Chrome loaded the extension without output errors (exit code 0) · Firefox coverage is deferred at the user's request.
- [x] **0.3** Configure ESLint + Prettier + strict TS config.
  - Test criteria: `lint` and `typecheck` scripts run clean on a fresh clone.
  - Notes: 2026-09-04 · ran `npm run lint --prefix extension`, `npm run typecheck --prefix extension`, and `npm run format:check --prefix extension` · all checks passed · TypeScript was pinned to 5.9.3 because the installed TypeScript ESLint release declares support through TypeScript 6.0 only.
- [x] **0.4** Scaffold FastAPI backend with a local `/health` endpoint.
  - Test criteria: local `curl /health` returns `200 {"status":"ok"}`.
  - Notes: 2026-09-04 · scope changed by user direction: Docker is not part of this application; removed Docker artifacts and replaced the acceptance test with a local HTTP `curl` test · ran `pytest server/tests/test_health.py server/tests/test_health_http.py -q`; both tests passed, including `curl.exe` returning `{"status":"ok"}` from a locally started Uvicorn server · test run emitted third-party deprecation warnings only.
- [x] **0.5** Set up dev scripts: `dev` (watch build), `build` (production), `test` (all suites).
  - Test criteria: each script runs successfully from a clean checkout.
  - Notes: 2026-09-04 · ran `npm run dev`, `npm run build`, and `npm run test` · local Vite and Uvicorn development services started; production build passed; lint, strict typecheck, formatting, and 2 server tests passed · the environment sandbox required the commands to run outside its restricted Node path lookup; test output contains third-party deprecation warnings only.

**Phase Gate 0:** ☑ All boxes above checked; Phase 1 may begin.

---

### Phase 1 — DOM / Accessibility Extraction Layer
**Objective:** structured, low-cost extraction of everything the DOM can tell us.

- [x] **1.1** Implement content-script DOM walker collecting role/text/bbox for interactive elements.
  - Test criteria: on a test form page, walker returns all inputs/buttons with correct bbox (±2px).
  - Notes: 2026-09-04 · ran `npm run test --prefix extension` against the mocked form page in `extension/tests/domWalker.test.ts` · 1 test passed; all three inputs/buttons returned their expected roles, labels/text, and exact bounding boxes (within ±0px) · made `innerText` optional after the initial jsdom test exposed that it may be undefined.
- [x] **1.2** Extract accessibility-tree attributes (ARIA roles/labels) alongside DOM data.
  - Test criteria: elements with only ARIA labels (no visible text) are still captured correctly.
  - Notes: 2026-09-04 · ran `npm run test --prefix extension` with the ARIA-only `menuitem` case in `extension/tests/domWalker.test.ts` · 2 tests passed; the walker preserved `role="menuitem"`, `ariaLabel`, text fallback, and bounding box for an element without visible text · ARIA label is represented as an optional field pending final schema validation in 1.3.
- [x] **1.3** Define and implement the Screen State JSON schema (§4.1) with a schema validator.
  - Test criteria: output validates against the JSON schema on 5 different site types.
  - Notes: 2026-09-04 · ran `npm run test --prefix extension` using the versioned validator in `extension/src/schemas/screenState.ts` · 8 extension tests passed, including 5 Screen State cases (form, dashboard, portal, e-commerce, SPA) and malformed-payload rejection · the current 1.0 schema supports DOM-sourced elements and will be extended as vision sources are implemented in Phase 2.
- [x] **1.4** Benchmark extraction latency.
  - Test criteria: median extraction time < 50ms on five representative DOM fixtures; documented Chrome-on-device measurement deferred to Phase 8 by user direction.
  - Notes: 2026-09-04 · ran `npm run test -- tests/domWalker.benchmark.test.ts --pool=forks --maxWorkers=1 --reporter=verbose` using five representative DOM fixtures · all 5 median-latency assertions passed below 50ms in jsdom; per-fixture test durations were 84–172ms for 101 samples including setup · deviation accepted by user: retain the Phase 8 Chrome-on-recorded-device benchmark as the authoritative performance measurement.

**Phase Gate 1:** ☑ All boxes above checked; Phase 2 may begin. Device-level latency evidence remains a Phase 8 requirement.

---

### Phase 2 — Local Vision Perception Module
**Objective:** real on-device visual perception for anything DOM cannot represent
(canvas, video, embedded images, iframes) — this phase carries the most rubric weight (25%).

- [ ] **2.1** Integrate ONNX Runtime Web with WebGPU backend, WASM fallback for unsupported devices.
  - Test criteria: a sample model runs inference successfully on both backends; fallback triggers correctly when WebGPU is unavailable.
  - Notes: 2026-09-04 · implemented `extension/src/content/visionRuntime.ts` and ran its focused Vitest suite, lint, strict typecheck, formatting, and production build · 3 backend-selection tests passed: WebGPU preference, fallback after WebGPU initialization failure, and WASM selection when WebGPU is absent · blocker: no packaged ONNX sample model or browser WebGPU inference run exists yet, so the required real inference on both backends has not been demonstrated.
- [ ] **2.2** Integrate OCR pipeline for text inside canvas/image regions.
  - Test criteria: OCR correctly reads text from 10 sample canvas/image screenshots (≥85% character accuracy).
  - Notes: 2026-09-04 · integrated local Tesseract.js worker lifecycle and canvas-region cropper in `extension/src/content/ocr.ts`; ran 10 OCR fixture tests plus lint, strict typecheck, and formatting · all 10 controlled OCR pipeline fixtures passed and workers were terminated after recognition · blocker: the fixtures inject a deterministic worker and do not yet exercise packaged `eng` language data over real screenshots, so measured character accuracy is not available.
- [ ] **2.3** Integrate face-detection model for video/image regions.
  - Test criteria: face detector correctly boxes faces in a labeled 20-image test set (≥90% recall).
  - Notes:
- [ ] **2.4** Fuse vision output with DOM output into one Screen State JSON (Fusion Engine), resolving duplicate/overlapping regions.
  - Test criteria: fused output has no duplicate elements for the same on-screen region across 5 test pages.
  - Notes:
- [ ] **2.5** Benchmark vision-pipeline latency and resource usage (CPU/GPU/memory).
  - Test criteria: median vision-pass latency and peak memory recorded; documented against the 20%-resource and 15%-latency targets.
  - Notes:

**Phase Gate 2:** ☐ All boxes above checked before starting Phase 3.

---

### Phase 3 — Privacy Firewall (PII Detection & Redaction)
**Objective:** nothing sensitive ever leaves the device.

- [ ] **3.1** Implement regex detectors for structured PII (Aadhaar, PAN, phone, email, card number, OTP).
  - Test criteria: 100% detection on a hand-built set of 30 structured PII samples, 0 false positives on 30 non-PII controls.
  - Notes:
- [ ] **3.2** Integrate local NER model for unstructured PII (names, addresses).
  - Test criteria: recall ≥ 90%, precision ≥ 85% on a labeled unstructured-text test set.
  - Notes:
- [ ] **3.3** Implement canvas-based pixel redaction for faces/sensitive image regions.
  - Test criteria: all faces flagged in Phase 2.3's test set are visibly masked in output screenshots.
  - Notes:
- [ ] **3.4** Implement DOM-text tokenization scheme (`[PII_<TYPE>_<N>]`) with a stable id map kept only in client memory.
  - Test criteria: tokenized output is reversible on-client only; server-bound payload contains zero raw values for all 3.1–3.3 test sets.
  - Notes:
- [ ] **3.5** Implement confidence-based decision gate (auto-mask vs. flag-for-review threshold).
  - Test criteria: threshold tuned so borderline cases (confidence 0.4–0.6) are flagged, not silently passed through, on a 20-sample borderline set.
  - Notes:

**Phase Gate 3:** ☐ All boxes above checked before starting Phase 4.

---

### Phase 4 — Structured Context Builder
**Objective:** minimal, task-relevant, safe payload — nothing more than the server needs.

- [ ] **4.1** Implement Set-of-Mark tagging for remaining (non-redacted) interactive elements.
  - Test criteria: every clickable/fillable element in test pages receives a unique, stable mark id.
  - Notes:
- [ ] **4.2** Implement task-aware field filtering ("minimum required context" principle).
  - Test criteria: payload for a single-step task (e.g. "click download") excludes unrelated form fields present on the same page.
  - Notes:
- [ ] **4.3** Implement compact JSON serialization.
  - Test criteria: payload size reduced ≥ 70% vs. raw DOM dump, measured across 5 test pages.
  - Notes:
- [ ] **4.4** Manual redaction audit before transmission.
  - Test criteria: manual spot-check of 20 serialized payloads confirms zero raw PII present.
  - Notes:

**Phase Gate 4:** ☐ All boxes above checked before starting Phase 5.

---

### Phase 5 — Backend Server & LLM/VLM Reasoning
**Objective:** server correctly reasons over sanitized context and returns a valid structured action.

- [ ] **5.1** Implement `/reason` FastAPI endpoint accepting the Context Builder's JSON schema.
  - Test criteria: endpoint accepts valid payloads (200) and rejects malformed ones (422) with clear errors.
  - Notes:
- [ ] **5.2** Integrate chosen open-weight LLM/VLM (name the specific model and hosting method used).
  - Test criteria: end-to-end call from a sample sanitized payload returns a response within timeout.
  - Notes:
- [ ] **5.3** Design and version the system prompt for structured action output.
  - Test criteria: 10 sample task payloads all produce schema-valid Action JSON (§4.2).
  - Notes:
- [ ] **5.4** Implement server-side response schema validation (reject/retry malformed model output).
  - Test criteria: intentionally malformed model output is caught and retried/rejected, never forwarded to client.
  - Notes:
- [ ] **5.5** Benchmark server round-trip latency.
  - Test criteria: median round-trip time recorded across 10 tasks; documented against the 15% latency target.
  - Notes:

**Phase Gate 5:** ☐ All boxes above checked before starting Phase 6.

---

### Phase 6 — Action Validation & Execution Loop
**Objective:** safe, correct execution of server-returned actions.

- [ ] **6.1** Implement risk-scoring module (factors: action type, target sensitivity, model confidence).
  - Test criteria: a labeled set of 15 sample actions (mix of low/medium/high risk) are scored consistently with expected risk tier.
  - Notes:
- [ ] **6.2** Implement local validation gate: auto-proceed on low risk, require confirmation on medium/high risk.
  - Test criteria: high-risk actions (e.g. "submit payment") never auto-execute in test runs; confirmation UI appears every time.
  - Notes:
- [ ] **6.3** Implement Action Executor mapping `target_id` back to live DOM elements (click/type/scroll/navigate).
  - Test criteria: all 4 action types execute correctly against 5 test pages with no misfires.
  - Notes:
- [ ] **6.4** Implement stale-reference handling (DOM changed since context was built).
  - Test criteria: executor detects a stale `target_id` and re-perceives instead of clicking the wrong element, verified on a page with dynamic content.
  - Notes:
- [ ] **6.5** Full-loop test: perceive → filter → reason → validate → act, on 5 real end-to-end tasks.
  - Test criteria: all 5 tasks complete successfully end-to-end with correct final outcome.
  - Notes:

**Phase Gate 6:** ☐ All boxes above checked before starting Phase 7.

---

### Phase 7 — Explainability & Audit Trail
**Objective:** every decision the agent makes is inspectable, locally, without exposing raw PII.

- [ ] **7.1** Implement local IndexedDB audit log, one entry per pipeline stage per action.
  - Test criteria: log entries exist for Observe, Detect PII, Redact, Reason, Validate, Act stages on a sample task.
  - Notes:
- [ ] **7.2** Build a simple UI panel (popup or side panel) to view the audit trace per task.
  - Test criteria: UI correctly renders the full trace for at least 3 completed tasks.
  - Notes:
- [ ] **7.3** Verify log completeness across varied tasks.
  - Test criteria: no missing pipeline stages across 5 different tasks' logs.
  - Notes:
- [ ] **7.4** Verify no raw PII ever appears in logs.
  - Test criteria: automated scan of log contents for regex-matchable PII patterns returns zero matches across all test runs so far.
  - Notes:

**Phase Gate 7:** ☐ All boxes above checked before starting Phase 8.

---

### Phase 8 — Testing, Benchmarking & Rubric Alignment
**Objective:** produce the actual numbers the evaluation rubric will be scored on.

- [ ] **8.1** Curate a labeled test dataset: ≥30 screen samples across site types (forms, dashboards, portals, e-commerce, SPAs), each with ground-truth elements and PII annotations.
  - Test criteria: dataset reviewed and versioned in `/tests/dataset`.
  - Notes:
- [ ] **8.2** Run and record visual-context accuracy evaluation against ground truth.
  - Test criteria: accuracy metric computed and documented in `results.md`.
  - Notes:
- [ ] **8.3** Run and record PII recall/precision evaluation.
  - Test criteria: recall/precision computed and documented; both above internally agreed minimum thresholds.
  - Notes:
- [ ] **8.4** Run and record redaction-precision evaluation.
  - Test criteria: precision metric computed; zero unredacted critical fields (Aadhaar/bank/OTP/faces) across the dataset.
  - Notes:
- [ ] **8.5** Profile client resource utilization (CPU/GPU/memory) on at least 2 device tiers (e.g. high-end laptop, mid-tier laptop).
  - Test criteria: profiling data captured and documented for both tiers.
  - Notes:
- [ ] **8.6** Benchmark end-to-end latency on 5 representative real tasks.
  - Test criteria: per-task latency breakdown (perceive/filter/reason/act) documented.
  - Notes:
- [ ] **8.7** Compile all metrics into a single `results.md` mapped explicitly to the 5 rubric criteria.
  - Test criteria: document exists and every rubric line item has a corresponding measured number.
  - Notes:

**Phase Gate 8:** ☐ All boxes above checked before starting Phase 9.

---

### Phase 9 — Packaging, Documentation & Demo Prep
**Objective:** a submittable, demoable, explainable final artifact.

- [ ] **9.1** Package cross-browser builds (Chrome-loadable build + Firefox `.xpi` via `web-ext`).
  - Test criteria: both packages install and run correctly on a clean browser profile.
  - Notes:
- [ ] **9.2** Write top-level README with setup, run, and test instructions.
  - Test criteria: a teammate unfamiliar with the project can follow the README to run the full stack from scratch.
  - Notes:
- [ ] **9.3** Prepare a live demo script covering 2–3 end-to-end tasks, including at least one that visibly demonstrates PII redaction.
  - Test criteria: demo script rehearsed end-to-end without failure at least twice.
  - Notes:
- [ ] **9.4** Record a backup demo video in case of live-demo failure.
  - Test criteria: video covers the same 2–3 tasks and plays back correctly.
  - Notes:
- [ ] **9.5** Finalize architecture and workflow diagrams for the pitch deck, consistent with this document.
  - Test criteria: diagrams reviewed against the actual implemented system (no drift from what was built).
  - Notes:
- [ ] **9.6** Rehearse Q&A on rubric-critical points: how vision and DOM are balanced, how borderline PII is handled, what happens on redaction failure.
  - Test criteria: team can answer each of these three questions with a specific, implementation-grounded answer.
  - Notes:

**Phase Gate 9:** ☐ All boxes above checked → project ready for submission/demo.

---

## 6. Rubric Alignment Matrix (fill in as Phase 8 completes)

| Rubric Criterion | Weight | Measured In | Result | Status |
|---|---|---|---|---|
| Visual context accuracy | 25% | Phase 8.2 | _(fill in)_ | ☐ |
| PII recall/precision | 20% | Phase 8.3 | _(fill in)_ | ☐ |
| Redaction precision | 20% | Phase 8.4 | _(fill in)_ | ☐ |
| Client resource utilization | 20% | Phase 8.5 | _(fill in)_ | ☐ |
| End-to-end latency | 15% | Phase 8.6 | _(fill in)_ | ☐ |

---

## 7. Suggested Repository Structure

```
privagent/
├── extension/
│   ├── src/
│   │   ├── content/        # DOM walker, vision pipeline, privacy firewall, executor
│   │   ├── background/     # service worker, orchestration
│   │   ├── ui/              # popup/side panel (React)
│   │   ├── models/          # ONNX model files (quantized)
│   │   └── schemas/         # Screen State JSON, Action JSON schemas
│   ├── manifest.json
│   └── vite.config.ts
├── server/
│   ├── app/
│   │   ├── main.py          # FastAPI entrypoint
│   │   ├── reasoning.py     # LLM/VLM integration
│   │   └── schemas.py       # pydantic models matching client schemas
│   └── requirements.txt
├── tests/
│   ├── dataset/             # labeled screens + PII ground truth
│   ├── extension/           # Playwright/Vitest tests
│   └── server/              # pytest suite
├── docs/
│   └── PrivAgent_Build_Specification.md   # this file
└── results.md                # Phase 8 output
```
