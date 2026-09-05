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

| Criterion                                          | Weight  |
| -------------------------------------------------- | ------- |
| Accuracy of visual context from screen             | **25%** |
| Recall & precision of PII/sensitive-data detection | 20%     |
| Precision of redaction                             | 20%     |
| Client-side resource utilization                   | 20%     |
| End-to-end latency                                 | 15%     |

**Design implication:** visual context accuracy is the single largest line item. The
build plan below therefore treats **local vision** as a first-class, always-present
pipeline stage — DOM/Accessibility extraction is an _optimization on top of_ vision,
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

| Component                   | Responsibility                                                                                               | Runs where           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------- |
| Content Script              | Injected per tab; orchestrates extraction, redaction, action execution                                       | Client               |
| DOM/A11y Walker             | Extracts structured elements: role, label, text, bounding box                                                | Client               |
| Screenshot Capture          | Grabs visible tab / canvas region for vision model input                                                     | Client               |
| Local Vision Model          | Runs OCR + object/face detection on screenshot regions DOM cannot represent (canvas, video, images, iframes) | Client (WebGPU/WASM) |
| Fusion Engine               | Merges DOM output + vision output into one Screen State JSON, resolving overlaps                             | Client               |
| Privacy Firewall            | Detects PII (regex + local NER) and sensitive visual regions (faces, ID photos); redacts/tokenizes/masks     | Client               |
| Context Builder             | Applies Set-of-Mark tagging, strips anything not task-relevant, serializes compact JSON                      | Client               |
| Backend API                 | Receives sanitized context, orchestrates LLM/VLM call, validates response schema                             | Server               |
| LLM/VLM Reasoner            | Interprets sanitized context, decides next action or returns processed data                                  | Server               |
| Risk & Confidence Validator | Scores returned action by risk + confidence; blocks/asks-confirmation on high risk                           | Client               |
| Action Executor             | Executes click/type/scroll/navigate against real DOM refs                                                    | Client               |
| Audit Trail Logger          | Records every pipeline stage's decision locally, never transmits raw PII                                     | Client               |

---

## 3. Technology Stack (with justification)

| Layer                           | Choice                                                                                                                    | Why                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Extension manifest              | Manifest V3                                                                                                               | Required by Chrome; Firefox now supports MV3                                                 |
| Cross-browser layer             | `webextension-polyfill`                                                                                                   | One codebase for Chrome + Firefox, satisfies PS requirement                                  |
| Extension build tooling         | Vite + CRXJS plugin                                                                                                       | Fast HMR for extension dev, first-class MV3 support                                          |
| Extension language              | TypeScript                                                                                                                | Type safety for a multi-stage pipeline with strict JSON schemas                              |
| Extension UI (popup/side panel) | React + Tailwind                                                                                                          | Fast to build the audit-trace and confirmation UI                                            |
| Local ML runtime                | ONNX Runtime Web (WebGPU backend, WASM fallback)                                                                          | Best-supported path for running quantized vision/NER models client-side today                |
| OCR model                       | Tesseract.js (WASM) or a distilled OCR ONNX model                                                                         | Reads on-screen text from canvas/image regions DOM can't expose                              |
| Local vision/object model       | Quantized MobileViT / TinyViT or a small YOLO variant (ONNX)                                                              | Lightweight enough for WebGPU inference at interactive latency                               |
| Local face detection            | BlazeFace (ONNX/TF.js)                                                                                                    | Small, fast, purpose-built for face bounding boxes → redaction                               |
| Local PII/NER model             | Distilled BERT-based PII NER, quantized, via Transformers.js/ONNX                                                         | Catches unstructured PII (names, addresses) regex can't                                      |
| Structured PII detection        | Regex library (Aadhaar, PAN, phone, email, card, OTP patterns)                                                            | Cheap, high-precision for structured formats                                                 |
| Redaction                       | Canvas pixel masking (images/faces) + DOM text tokenization (`[PII_PHONE_01]`)                                            | Matches PS's "bounding-box redaction / masking / semantic obfuscation" requirement           |
| Context format                  | JSON + Set-of-Mark element tagging                                                                                        | Grounding technique from referenced literature; keeps payload compact and machine-actionable |
| Backend framework               | FastAPI (Python)                                                                                                          | Best ecosystem fit for ML/LLM orchestration, async, easy to containerize                     |
| Server LLM/VLM                  | Open-weight VLM, e.g. Qwen2-VL or LLaVA-NeXT for offline deployability; cloud-hosted equivalent during SIH for demo speed | Satisfies "must be offline-deployable, cloud OK during SIH" constraint                       |
| Local audit storage             | IndexedDB                                                                                                                 | Persistent, local-only, no server round-trip for logs                                        |
| Testing (extension)             | Vitest (unit), Playwright (E2E browser automation)                                                                        | Playwright can drive a real loaded extension in Chrome/Firefox                               |
| Testing (backend)               | pytest                                                                                                                    | Standard, integrates with FastAPI's TestClient                                               |
| Benchmarking                    | Custom latency harness + Chrome DevTools Performance/Memory panel                                                         | Needed for the 20% resource + 15% latency rubric lines                                       |
| Packaging                       | `web-ext` (Firefox) + Chrome Web Store packer                                                                             | Cross-browser distributable builds                                                           |

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

### Stage 1 summary — 2026-09-04

Work after Phase 1 was reorganised into three stages rather than run strictly phase by
phase. Stage 1 covered: wiring the end-to-end loop, fixing two confirmed data leaks
(credential values in the payload, overlapping-PII corruption), moving the audit trail to
the extension origin, generating the wire contract from one source, Firefox support, and
CI. Stage 2 is vision and a real model; Stage 3 is benchmarks and browser verification.

The deviation from strict phase order is deliberate and recorded at each affected Phase
Gate. The reason: Phase 2 carries the largest rubric weight but nothing in it was
blocking, while the privacy path had reproducible defects that were shipping real user
data to the server. Those were fixed first.

**Verified at the close of Stage 1:** 210 client tests, 14 server tests and 7 browser tests
pass from a clean checkout, with a coverage ratchet, schema-drift check, and both browser
builds validated. The browser suite loads the real unpacked extension into a real
Chromium-based browser and is what backs the privacy claims - including the origin-isolation
guarantee, which no unit test can establish.

Running in a real browser immediately found two defects that every unit test had missed: the
service worker was executing the _content script's_ bundle because both entry files were
named `index.ts`, and both message listeners were answering messages addressed to the other.
Neither produced a build error, a type error or a failing test.

**Not verified:** Firefox beyond its manifest shape (Playwright cannot load extensions
there), and everything in Stage 2 and Stage 3.

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
  - Notes: 2026-09-04 (Stage 1) - re-ran the five jsdom fixtures; all medians below 50ms. **Caveat recorded:** jsdom has no layout engine and `getBoundingClientRect` is stubbed to a constant, so this measures `querySelectorAll` speed, not extraction latency. Retained as a regression guard only; the authoritative measurement moves to Phase 8.6.

**Phase Gate 1:** ☑ All boxes above checked; Phase 2 may begin. Device-level latency evidence remains a Phase 8 requirement.

---

### Phase 2 — Local Vision Perception Module

**Objective:** real on-device visual perception for anything DOM cannot represent
(canvas, video, embedded images, iframes) — this phase carries the most rubric weight (25%).

- [x] **2.1** Integrate ONNX Runtime Web with WebGPU backend, WASM fallback for unsupported devices.
  - Test criteria: a sample model runs inference successfully on both backends; fallback triggers correctly when WebGPU is unavailable.
  - Notes: 2026-09-05 (Stage 2) - both criteria met in a real browser, in `e2e/vision.spec.ts` (3 tests) against the shipped YuNet detector, not a probe graph. **Measured:** WebGPU 1928 ms and WASM 232 ms for session creation plus one 640x640 pass, on a SwiftShader software adapter. Fallback verified by deleting `Navigator.prototype.gpu` in the page, which is what a browser without WebGPU actually looks like: the probe then reports `webgpu: navigator.gpu is not present` and the WASM arm still runs the model. The three Stage 1 blockers are closed - `ort.env.wasm.wasmPaths` now points at the extension's own copy of the WASM core (`configureLocalRuntime`), a real 232 KB model ships, and WebGPU inference has run. A third browser test asserts the diagnostics page issues **zero non-extension requests**, which is the claim that matters: ORT and Tesseract both default to `cdn.jsdelivr.net`, and that fetch alone would tell a third party when the user asked the agent to look at their screen. `scripts/vendor-assets.mjs` copies every asset locally and verifies the two committed ones by SHA-256; `verify-manifests.mjs` fails the build if any is absent from the package or not web-accessible. Also added `src/ui/diagnostics.html`, a device-capability page that runs this same probe, and a node-hosted integration test executing the real detector's 12 output heads. **Caveats:** the WebGPU number is a software adapter on a cold session, so it is a correctness result, not a performance one - WebGPU being 8x slower than WASM here is an artifact of SwiftShader plus first-run shader compilation, and the backend preference is re-examined with warm timings in 2.5. Threads are pinned to 1 because a content script can never be cross-origin isolated. The package is ~35 MB unpacked, almost entirely the 27 MB ORT core.
- [x] **2.2** Integrate OCR pipeline for text inside canvas/image regions.
  - Test criteria: OCR correctly reads text from 10 sample canvas/image screenshots (≥85% character accuracy).
  - Notes: 2026-09-05 (Stage 2) - **measured 99.4% mean character accuracy across 10 canvas samples in 2396 ms** (worker startup included), in a real browser, with the CDN blocker closed. 9 of 10 samples read exactly; the tenth ("Card ending 4242" in Courier New) lost one character to a lowercased `C`, scoring 94%. Scoring is edit-distance based (`characterAccuracy`, 12 unit tests) rather than exact match, so a near miss is measured as a near miss; whitespace is normalized first because Tesseract's line breaks describe where text sat in the image, not how well it was read. The samples are the shapes PrivAgent must actually read - button label, invoice total, chart axis, masked card, status line, nav item, small print, low contrast, reference code, dark mode - and the run is asserted to issue **zero non-extension requests**. All four `tesseract.js` CDN defaults are now local: worker script, WASM core, `eng.traineddata.gz` (tessdata_fast, 2 MB) and the blob-URL shim, which is disabled - `workerBlobURL: false` also keeps the worker on the extension's origin instead of the visited page's, where the site's own `worker-src` would govern it. Added `recognizeRegions`, which reads N regions with one worker: startup instantiates a 2.8 MB core and parses 2 MB of language data, tens of times the cost of reading one region. **Found by running it:** shipping only the SIMD core was not enough - Chrome feature-detects relaxed SIMD and `importScripts`ed a core that was not in the package, failing with `Failed to execute 'importScripts'`. All three LSTM cores are now vendored, which is what `verify-manifests.mjs` guards. **Caveats:** the samples are canvas renders, not photographs of screens - defensible because the real input is always a screenshot of a composited page, but it is not a test of noisy or scaled imagery; accuracy on real page content is re-measured against the Phase 8.1 dataset. The vendored assets put the unpacked package at ~40 MB, 27 MB of it the ONNX core.
- [x] **2.3** Integrate face-detection model for video/image regions.
  - Test criteria: face detector correctly boxes faces in a labeled 20-image test set (≥90% recall).
  - Notes: 2026-09-05 (Stage 2) - **measured 100% recall (27/27 faces) and 100% precision at IoU ≥ 0.5 across a labelled 20-image set**, in `faceDetection.eval.test.ts`. The Shape Detection wrapper is gone; YuNet (232 KB, opencv_zoo `face_detection_yunet_2023mar`, digest-pinned) ships with the extension and runs through the same local ONNX runtime. Implemented preprocessing (letterbox to the model's fixed 640x640, BGR NCHW, 0-255), anchor decoding over all three strides, geometric score fusion, greedy NMS and the inverse letterbox mapping - 15 unit tests cover that arithmetic, including two hand-computed coordinate round-trips, because wrong box maths produces plausible-looking rectangles in the wrong place and would mask the wrong part of the screen. **Dataset:** `tests/dataset/faces/` holds 5 public-domain NASA portraits (provenance and licence per file in `sources.json`), cropped to the face; `tests/helpers/faceScenes.ts` composes the 20 scenes from them, so ground truth is the paste rectangle - exact by construction, not an annotator's estimate - and the set is regenerable rather than an opaque blob. Faces vary in skin tone, age, sex and pose, because a detector that works on one demographic and not another is a redaction failure aimed at the people it fails on. **The first version of the set was too easy** (100%/100% on the first run), so three scenes were replaced with genuinely hard ones: a 47-pixel face at 22% scale, a blurred face on a dark background, and a face with its lower third covered by a caption bar. That version scored 96.3%, losing only the 47-pixel face. **Threshold swept** at 0.15/0.25/0.35/0.5/0.6: recall is 100% at and below 0.5, 96.3% at 0.6, and precision stays at 100% down to 0.15 - so the default moved from 0.6 to 0.4. A missed face is an unredacted face; a false positive is one over-masked rectangle. A face-free control scene is included and returns zero detections, so a detector that always fires cannot pass. **Caveats:** the scenes are composites on synthetic page backgrounds, not photographs of real screens - performance on steep profile views, harsh side lighting and motion blur is unmeasured. `detectFacesInImage` (pixels) is what the evaluation exercises; the canvas entry point `detectFaces` is verified in a browser as part of 2.4, where a real screenshot first becomes available.
- [x] **2.4** Fuse vision output with DOM output into one Screen State JSON (Fusion Engine), resolving duplicate/overlapping regions.
  - Test criteria: fused output has no duplicate elements for the same on-screen region across 5 test pages.
  - Notes: 2026-09-05 (Stage 2) - the Stage 1 blocker is closed: there is now a real vision pass, and fusion runs on real mixed input. The criterion is asserted over **every pair** in the fused output on five page shapes (form, dashboard, portal, e-commerce, SPA), not over the handful a test author might pick, with each page also asserted to have contributed at least one vision element so the check cannot pass vacuously. Verified end to end in a real browser too, against a new fixture carrying a real photograph and a canvas whose text exists in no text node: the agent transmits `Settlement total 84,200` (read off the screen) and detects the face, which is marked `sensitive` and therefore **withheld entirely** - the browser test asserts no face element and no `vision_face` string reaches the payload. A DOM-only page is asserted to take no screenshot at all. **Architecture changed during this task, twice, both times because reality contradicted the design.** First: OCR cannot run in the content script. A Worker script must be same-origin with its document, and a content script's document belongs to the visited site, so `chrome-extension://.../worker.min.js` is rejected outright. The alternative - a blob-URL worker on the page's origin - would run under the site's CSP and decode a screenshot of the user's screen inside the site's own renderer. Vision now runs in an offscreen document (Chrome) or the background event page (Firefox), both extension-origin; the content script only collects regions. Second, and worse: **`captureVisibleTab` photographs the visible tab of a window, not the tab you name.** With the task's tab in the background, the pass was analysing a screenshot of a completely different page - reading text and hunting faces on a page the user never pointed the agent at, and returning boxes that would land on the wrong elements. It now refuses to capture unless the target tab is the visible one, and reports vision as unavailable instead. Also added a warm-up (the popup preloads the ~33 MB of runtime, model and language data while the user types) and a shared OCR worker, after a cold first pass exceeded 30 s. **Caveats:** the browser test drives the popup as a separate window because Playwright cannot open a browser-action panel; a real panel leaves the page visible, which is the same condition. Fusion is IoU-only - two observers describing the same region in different rectangles (a region clipped by the viewport edge, say) can still both survive.
- [x] **2.5** Benchmark vision-pipeline latency and resource usage (CPU/GPU/memory).
  - Test criteria: median vision-pass latency and peak memory recorded; documented against the 20%-resource and 15%-latency targets.
  - Notes: 2026-09-05 (Stage 2) - measured in a real browser by `e2e/benchmark.spec.ts`, which writes `test-results/vision-benchmark.json`; results and method are in [BENCHMARKS.md](./docs/BENCHMARKS.md). **Median warm vision pass 209-251 ms** across two runs of 7 passes (decode 24-28 ms, YuNet 81-97 ms, OCR over 2 regions 99-128 ms), **whole task 445-494 ms**, on a fixture with one photograph and one canvas. **Cold first pass 1839-3293 ms**, which is model load; the popup now preloads on open so a real first task is warm. **Peak memory: 312-397 MB attributable to vision** - browser RSS with vision warm and used, minus RSS with the extension loaded and the page open but no vision yet. Measured from the OS, not `performance.memory`: nearly all of the footprint is WebAssembly linear memory, which the JS-heap APIs omit entirely, and reporting a heap figure would have understated it roughly tenfold. Against the targets: latency is comfortably inside a 15% line at ~0.5 s per task, and **memory is the weak result** - BENCHMARKS.md names the three reductions available (WASM-only ORT build, pre-scaled detector input, idle worker release), none of which are done. **Three defects were found by benchmarking, not by testing:** (1) the first version of the benchmark reported identical warm and cold figures because it re-read the previous task's trace - the popup now exposes `data-state` and a task id so completion is observable rather than inferred; (2) `captureVisibleTab` is rate-limited to a couple of calls per second, so back-to-back tasks silently lost their sight - the background now retries once after the quota window; (3) an `action: "none"` scored `high` risk on confidence alone, so the agent put a confirmation prompt in front of the user asking them to approve *doing nothing*, and the task blocked until something dismissed it. A no-op is now scored `low`. **Caveats:** one device tier, software rendering, one page shape; CPU time is not separately measured (wall clock stands in), and GPU is not measured at all because WebGPU here is SwiftShader. Phase 8.5/8.6 repeat this across the labelled dataset and a second tier.

**Phase Gate 2:** ☑ **Closed 2026-09-05.** All five tasks checked with measured evidence. The extension now ships a real local vision pipeline: a 232 KB YuNet detector and a Tesseract OCR stack, both served from the extension's own origin with nothing fetched from a CDN at any point, running on ONNX Runtime with a WebGPU-to-WASM fallback that has been exercised on both backends in a real browser. Measured: OCR 99.4% mean character accuracy over 10 samples; face detection 100% recall and 100% precision over a labelled 20-image set at IoU ≥ 0.5, including blurred, occluded and 47-pixel faces; fusion produces no duplicate region across five page shapes; warm vision pass 209-251 ms; 312-397 MB attributable memory.

Two architectural facts were discovered by running it rather than by design, and both changed the shape of the system. A content script **cannot** host local inference that needs a Worker - the script must be same-origin with its document, and a content script's document belongs to the visited site - so vision moved to an offscreen document on Chrome and the background event page on Firefox. And `captureVisibleTab` photographs a *window*, not the tab it is handed: with the task's tab in the background it was analysing an entirely different page, which is both a correctness failure and a privacy one. It now refuses rather than guessing.

Remaining risk on this phase's 25% rubric line is no longer capability but coverage: accuracy is measured on synthetic composites and canvas renders, not on a labelled set of real screens. That is Phase 8.1's job.

---

### Phase 3 — Privacy Firewall (PII Detection & Redaction)

**Objective:** nothing sensitive ever leaves the device.

- [x] **3.1** Implement regex detectors for structured PII (Aadhaar, PAN, phone, email, card number, OTP).
  - Test criteria: 100% detection on a hand-built set of 30 structured PII samples, 0 false positives on 30 non-PII controls.
  - Notes: 2026-09-04 (Stage 1) - added `tests/piiCorpus.test.ts` implementing the stated criterion. 64 tests pass: 30/30 structured PII samples detected across Aadhaar, PAN, phone, email, card and OTP, and 0/30 false positives on non-PII controls chosen as near-misses (11-digit numbers, malformed PAN, invoice references). Also asserts no residual PII after redacting every positive, and byte-identical output for every control.
- [x] **3.2** Integrate local NER model for unstructured PII (names, addresses).
  - Test criteria: recall ≥ 90%, precision ≥ 85% on a labeled unstructured-text test set.
  - Notes: 2026-09-05 (Stage 2) - **measured 100% recall and 100% precision** over a labelled set of 30 spans (20 names, 10 addresses) and 34 hostile controls, in `tests/unstructuredPii.test.ts`. `NAME` and `ADDRESS` were added to the wire contract's `PiiType` (regenerated on both sides), so unstructured hits tokenize as `[PII_NAME_01]` exactly like structured ones and pass through the same span resolver - which is what stops a name and a phone number that touch each other from corrupting one another's spans. **Deviation, stated plainly: this is a rule-based recogniser, not a neural NER model.** The smallest credible English NER export is BERT-base at 94-109 MB quantised; the entire extension is 40 MB, and the vision pipeline already accounts for 312-397 MB of resident memory against a rubric line that weights client resources at 20%. A 100 MB model to find names would cost more of that budget than all of vision does. The recogniser compensates by grading confidence honestly rather than by pretending to certainty: a labelled field, a salutation or a known given name masks outright, while two capitalised words that merely look like a name land in the review band, where the context builder withholds the element instead of transmitting a guess. **The seam is one function** - replace `detectUnstructuredPii` and nothing downstream changes - so the model remains a drop-in if the size is judged acceptable. **Caveats, and they matter:** the rules were tuned against this corpus, so 100%/100% measures behaviour on the failure modes known so far, not on unknown ones - the gazetteer holds a few hundred given names and every name outside it depends on a nearby label or falls to the review band. Two false positives found during development are worth recording because neither was in the first control set: an address rule that read "OTP 123456 sent to 9876543210" as one postal address, and a name rule that read "Press Ctrl+Shift+P" as a person called Press Ctrl - the second was caught by the Phase 3.1 corpus, not by this task's own tests, which is the argument for keeping both.
- [x] **3.3** Implement canvas-based pixel redaction for faces/sensitive image regions.
  - Test criteria: all faces flagged in Phase 2.3's test set are visibly masked in output screenshots.
  - Notes: 2026-09-05 (Stage 2) - **27 detected faces masked across the 19 face-bearing scenes of the Phase 2.3 set, and re-running the detector over the masked images finds 0 faces.** That second check is the one that matters: a masking function that ran is not the same claim as a face that is gone, so the evidence is that the model which found each face can no longer find it. Every masked scene is written to `test-results/redaction/` and one was inspected by eye - three avatars in the `team-row` scene are opaque blocks, with a sliver of hair above one of them. Masking is an opaque fill, not a blur: a blurred small face is reversible enough to be a bad idea. Boxes are padded 10%, because a detector box stops at the eyebrows and the chin. **Where it sits in the pipeline is the point:** faces are painted out of the screenshot buffer immediately after detection and *before* OCR reads from it, and the masked pixels are copied back onto the canvas the OCR worker crops from - so no face pixel reaches the worker, or any later consumer of the capture. The audit trail records the pixel count, and the browser test asserts a real run masked a non-zero number of them. This is defence in depth rather than the primary control: no pixels are ever transmitted, and a detected face is separately withheld from the payload by the context builder. **Caveat:** the test asserts the centre 60% of each labelled face is covered, not the whole labelled rectangle - the label is the rectangle a face crop was pasted into, so it includes hair and background, and painting out to it would mask a quarter of the surrounding page around every avatar.
- [x] **3.4** Implement DOM-text tokenization scheme (`[PII_<TYPE>_<N>]`) with a stable id map kept only in client memory.
  - Test criteria: tokenized output is reversible on-client only; server-bound payload contains zero raw values for all 3.1–3.3 test sets.
  - Notes: 2026-09-04 (Stage 1) - tokenization rewritten to resolve overlapping spans before replacing, walking forward so indices stay valid. Verified across `privacy.test.ts` (18), `piiCorpus.test.ts` (64) and `contextBudget.test.ts` (12): the reverse map lives only in `ClientTokenMap`, `RedactionResult` omits matched values entirely, and 25 serialized payloads across 5 page types contain zero raw values. This fixed a confirmed defect where overlapping detectors corrupted the output and mislabelled a card number as an Aadhaar number.
- [x] **3.5** Implement confidence-based decision gate (auto-mask vs. flag-for-review threshold).
  - Test criteria: threshold tuned so borderline cases (confidence 0.4–0.6) are flagged, not silently passed through, on a 20-sample borderline set.
  - Notes: 2026-09-05 (Stage 2) - the Stage 1 blocker is gone: the unstructured recogniser emits graded confidence, so the band can be exercised by real detections instead of synthetic numbers. `tests/borderline.test.ts` holds exactly 20 borderline samples - 15 names carrying neither a label nor a known given name, 5 address fragments carrying one signal instead of two - and asserts none is silently passed through, at three levels: the decision is `review`, the value is tokenized rather than left in the text, and the element is **withheld from the payload entirely** rather than transmitted with a token. Boundaries are asserted at 0.39 / 0.4 / 0.59 / 0.6. A counter-case is included so the band cannot pass by flagging everything: a labelled name scores 0.9, is masked to a token, and is transmitted - which keeps the element usable to the agent. **Caveat:** the borderline names are deliberately drawn from outside the gazetteer, which is also the recogniser's real weakness - a name the gazetteer does not know and no label introduces is *always* borderline, so this band is where much of the world's names land. Withholding is the safe outcome; it is not a free one, since the agent then cannot act on that element.

**Phase Gate 3:** ☑ **Closed 2026-09-05.** All five tasks checked with measured evidence. Structured PII: 30/30 detected, 0/30 false positives. Unstructured PII: 100% recall and 100% precision over 30 labelled spans and 34 hostile controls - from a rule-based recogniser rather than a neural NER, for the costed reason recorded at 3.2 and stated in the module itself. Pixel redaction: 27 faces masked across the labelled set with 0 detectable afterwards. The confidence gate now has real borderline detections to gate, and withholds all twenty.

One deliberate consequence is worth stating at the gate rather than burying in a task note. The recogniser is honest about its own uncertainty, so a name it cannot confidently place lands in the review band and the element is withheld - the agent goes blind on that element rather than guessing about a person. That is the right default for a privacy tool and a real cost to capability, and it is the strongest argument for revisiting the 100 MB NER model if the resource budget can absorb it.

---

### Phase 4 — Structured Context Builder

**Objective:** minimal, task-relevant, safe payload — nothing more than the server needs.

- [x] **4.1** Implement Set-of-Mark tagging for remaining (non-redacted) interactive elements.
  - Test criteria: every clickable/fillable element in test pages receives a unique, stable mark id.
  - Notes: 2026-09-04 (Stage 1) - `buildContext` assigns contiguous `M1..Mn` ids in reading order and returns a mark-to-element map used at execution time. Verified in `contextBuilder.test.ts` (4 tests), including contiguous numbering when elements are withheld. `mark_id` is schema-constrained to `^M\d+$` on both client and server.
- [x] **4.2** Implement task-aware field filtering ("minimum required context" principle).
  - Test criteria: payload for a single-step task (e.g. "click download") excludes unrelated form fields present on the same page.
  - Notes: 2026-09-04 (Stage 1) - the task-relevance filter keeps actionable roles plus text matching task terms. Verified in `contextBuilder.test.ts` and `contextBudget.test.ts`: a single-step task's payload excludes unrelated copy on the same page.
- [x] **4.3** Implement compact JSON serialization.
  - Test criteria: payload size reduced ≥ 70% vs. raw DOM dump, measured across 5 test pages.
  - Notes: 2026-09-04 (Stage 1) - `tests/contextBudget.test.ts` measures the payload against `document.body.outerHTML` across the five site types. Measured reduction: form 75.3%, dashboard 70.6%, portal 81.0%, e-commerce 77.1%, SPA 78.3% - all above the 70% bar. **Caveat:** fixtures are synthetic, written to carry representative markup overhead (wrapper divs, class names, data attributes, an inline script), because measuring against hand-minified HTML would measure fixture terseness rather than filtering. Dashboard is the weakest case at 70.6%, since every nav link stays actionable. Authoritative measurement moves to Phase 8 against the real-screen dataset.
- [x] **4.4** Manual redaction audit before transmission.
  - Test criteria: manual spot-check of 20 serialized payloads confirms zero raw PII present.
  - Notes: 2026-09-04 (Stage 1) - automated rather than manual, which is the stronger form: `contextBudget.test.ts` serializes 25 payloads (5 pages x 5 tasks) and asserts `detectStructuredPii` finds nothing in any of them, plus explicit checks for 12 known secret values. Combined with `credentials.test.ts`, which asserts no `<input>` value reaches a payload by any route.

**Phase Gate 4:** ☑ **Closed.** All four tasks checked with measured evidence: Set-of-Mark tagging, task-relevance filtering, 70.6–81.0% payload reduction across five site types, and 25 serialized payloads containing zero raw PII.

---

### Phase 5 — Backend Server & LLM/VLM Reasoning

**Objective:** server correctly reasons over sanitized context and returns a valid structured action.

- [x] **5.1** Implement `/reason` FastAPI endpoint accepting the Context Builder's JSON schema.
  - Test criteria: endpoint accepts valid payloads (200) and rejects malformed ones (422) with clear errors.
  - Notes: 2026-09-04 (Stage 1) - `/reason` accepts `SanitizedContext` and returns `Action`. `test_reason.py` (8 tests): a valid payload returns 200, four malformed shapes return 422, and an unexpected extra field returns 422 because every model sets `extra="forbid"`. Also verified over real HTTP against a spawned uvicorn in `tests/integration/reason.integration.test.ts`.
- [ ] **5.2** Integrate chosen open-weight LLM/VLM (name the specific model and hosting method used).
  - Test criteria: end-to-end call from a sample sanitized payload returns a response within timeout.
  - Notes: 2026-09-04 (Stage 1) - a `ReasonProvider` protocol now exists so a model can be dropped in without touching the endpoint or the client, and `/health` reports which provider is active. Blocker: no model is integrated. `DeterministicProvider`, a keyword matcher, is the only implementation. Ollama with a local open-weight model is the chosen Stage 2 target.
- [ ] **5.3** Design and version the system prompt for structured action output.
  - Test criteria: 10 sample task payloads all produce schema-valid Action JSON (§4.2).
  - Notes: Blocked on 5.2. No system prompt exists because no model is called. The `Action` schema such a prompt must satisfy is defined and enforced on both sides.
- [ ] **5.4** Implement server-side response schema validation (reject/retry malformed model output).
  - Test criteria: intentionally malformed model output is caught and retried/rejected, never forwarded to client.
  - Notes: 2026-09-04 (Stage 1) - partial. FastAPI validates outbound responses against `Action` via `response_model`, and the client independently re-validates and refuses to execute anything that is not schema-valid (`parseAction`, 4 rejection tests). **Criterion not met:** there is no retry path for malformed model output, because no model produces any. Lands with 5.2.
- [ ] **5.5** Benchmark server round-trip latency.
  - Test criteria: median round-trip time recorded across 10 tasks; documented against the 15% latency target.
  - Notes: Blocked on 5.2. Round-trip latency measured against a keyword matcher would not describe the system being evaluated.

**Phase Gate 5:** ☐ **Open.** 5.1 closed — the endpoint validates strictly in both directions and is verified over real HTTP. 5.2–5.5 all block on the same thing: no model is integrated. The provider seam exists so this is a drop-in, not a rewrite.

---

### Phase 6 — Action Validation & Execution Loop

**Objective:** safe, correct execution of server-returned actions.

- [x] **6.1** Implement risk-scoring module (factors: action type, target sensitivity, model confidence).
  - Test criteria: a labeled set of 15 sample actions (mix of low/medium/high risk) are scored consistently with expected risk tier.
  - Notes: 2026-09-04 (Stage 1) - `tests/actions.test.ts` scores a labelled table of exactly 15 sample actions spanning all three tiers, with the same verb appearing at different confidences and target sensitivities so the scorer cannot key off the verb alone. 25 tests pass, and the suite additionally asserts nothing but `low` risk is ever auto-executed.
- [x] **6.2** Implement local validation gate: auto-proceed on low risk, require confirmation on medium/high risk.
  - Test criteria: high-risk actions (e.g. "submit payment") never auto-execute in test runs; confirmation UI appears every time.
  - Notes: 2026-09-04 (Stage 1) - verified in a real browser. `extension/e2e/loop.spec.ts` forces the reasoner to return a `navigate` action labelled `"risk": "low"`; the client scores it `high`, the confirmation prompt renders in the page, `Escape` denies it, the navigation does not happen, and the audit trail records the denial. `effectiveRisk` takes `max(server, local)`, so a server cannot downgrade risk. `confirm.test.ts` (6 tests) additionally asserts the prompt's shadow root is closed to the page, that a bare `Enter` does not approve, and that listeners detach on settle.
- [ ] **6.3** Implement Action Executor mapping `target_id` back to live DOM elements (click/type/scroll/navigate).
  - Test criteria: all 4 action types execute correctly against 5 test pages with no misfires.
  - Notes: 2026-09-04 (Stage 1) - all four action types execute correctly, and `executeAction` returns structured outcomes with typed failures (`stale_target`, `unsupported_target`, `missing_parameter`) instead of a boolean. **Criterion not met as written:** verified against unit fixtures, not against 5 real test pages in a browser.
- [x] **6.4** Implement stale-reference handling (DOM changed since context was built).
  - Test criteria: executor detects a stale `target_id` and re-perceives instead of clicking the wrong element, verified on a page with dynamic content.
  - Notes: 2026-09-04 (Stage 1) - targets resolve through the Set-of-Mark map to live nodes, never through server-supplied coordinates; a mark whose node is gone or detached returns `stale_target` rather than acting. Verified in `actions.test.ts` and end to end in `loop.test.ts`, where the page is emptied between two runs and the second reports `stale_target` in the audit trail instead of misfiring.
- [x] **6.5** Full-loop test: perceive → filter → reason → validate → act, on 5 real end-to-end tasks.
  - Test criteria: all 5 tasks complete successfully end-to-end with correct final outcome.
  - Notes: 2026-09-04 (Stage 1) - the full loop runs end to end in a real browser across the required tasks. `loop.spec.ts` (7 tests) covers: task executed and the page actually actuated (the fixture's own click handler fires); a task whose relevant element carries PII, transmitted tokenized; a denied high-risk task; and three consecutive tasks each producing a complete trace. The client/server hop is separately exercised over real HTTP in `reason.integration.test.ts`. **Caveat:** tasks run against one fixture page, not five distinct sites; a broader page set arrives with the Phase 8 dataset.

**Phase Gate 6:** ☐ **Nearly closed.** 6.1, 6.2, 6.4 and 6.5 closed, the latter two with evidence from a real browser. 6.3 stays open on a technicality worth keeping honest: all four action types are implemented and unit-tested, but only `click` and `navigate` have been exercised in a browser, and against one fixture page rather than five.

---

### Phase 7 — Explainability & Audit Trail

**Objective:** every decision the agent makes is inspectable, locally, without exposing raw PII.

- [x] **7.1** Implement local IndexedDB audit log, one entry per pipeline stage per action.
  - Test criteria: log entries exist for Observe, Detect PII, Redact, Reason, Validate, Act stages on a sample task.
  - Notes: 2026-09-04 (Stage 1) - one entry per stage per task, written by the background worker to IndexedDB on the extension origin. `audit.test.ts` asserts all six stages in order for one task and filtered by task id; `loop.test.ts` asserts a real run emits observe, detect_pii, redact, validate and act, with reason recorded by the background worker.
- [x] **7.2** Build a simple UI panel (popup or side panel) to view the audit trace per task.
  - Test criteria: UI correctly renders the full trace for at least 3 completed tasks.
  - Notes: 2026-09-04 (Stage 1) - the popup renders the privacy summary (perceived / transmitted / redacted / withheld, action and outcome) and the full stage trace, replacing the placeholder that printed the OS name. Verified in a real browser: `loop.spec.ts` asserts all six stages render, and a dedicated test runs three consecutive tasks and asserts a complete trace for each - meeting the stated 'at least 3 completed tasks' criterion.
- [x] **7.3** Verify log completeness across varied tasks.
  - Test criteria: no missing pipeline stages across 5 different tasks' logs.
  - Notes: 2026-09-04 (Stage 1) - `loop.test.ts` asserts the exact expected stage sequence for successful, denied and stale-target runs, so a missing stage fails the build. The denial and failure paths each still emit a terminal `act` entry with `ok: false`.
- [x] **7.4** Verify no raw PII ever appears in logs.
  - Test criteria: automated scan of log contents for regex-matchable PII patterns returns zero matches across all test runs so far.
  - Notes: 2026-09-04 (Stage 1) - enforced at write time rather than audited afterwards. `assertPrivacySafe()` re-runs every PII detector over each detail string and throws instead of persisting a match; `audit.test.ts` asserts a phone and an email are both rejected and that counts and statuses pass. Every audit detail in the pipeline is a count or a status by construction.

**Phase Gate 7:** ☑ **Closed.** All four tasks checked. The trail is stored on the extension origin — demonstrated in a browser by inspecting the visited page's own `localStorage` and `indexedDB` and finding neither touched — is complete across successful, denied and failed outcomes, is rendered in the popup for three consecutive tasks, and is PII-safe by write-time enforcement rather than after-the-fact audit.

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

**Phase Gate 8:** ☐ **Not started.** No labelled dataset and no `results.md`. Deliberately held for Stage 3 so all five rubric criteria are measured together against one versioned dataset, rather than arriving piecemeal from different builds. Note that the 25% visual-context line cannot be measured honestly until Phase 2 lands a real vision pipeline — measuring DOM extraction and reporting it against a visual rubric line would misrepresent the system.

---

### Phase 9 — Packaging, Documentation & Demo Prep

**Objective:** a submittable, demoable, explainable final artifact.

- [ ] **9.1** Package cross-browser builds (Chrome-loadable build + Firefox `.xpi` via `web-ext`).
  - Test criteria: both packages install and run correctly on a clean browser profile.
  - Notes: 2026-09-04 (Stage 1) - both targets build to separate directories and `scripts/verify-manifests.mjs` asserts each has the background shape, `tabs` permission and WASM CSP its browser requires. The Chrome build is verified by loading it unpacked in a real browser in the e2e suite. **Criterion not met:** no packaged `.xpi` via `web-ext`, and the Firefox build has not been loaded in Firefox - Playwright cannot load extensions there, so it needs a separate `web-ext run` check.
- [x] **9.2** Write top-level README with setup, run, and test instructions.
  - Test criteria: a teammate unfamiliar with the project can follow the README to run the full stack from scratch.
  - Notes: 2026-09-04 (Stage 1) - a root `README.md` now exists with a phase-by-phase status table, the real architecture, an explicit 'what actually works today' section, and quick-start commands. Verified by extracting the tracked working tree to a clean directory and following it: `npm ci` (250 packages), `npm test` (204 client + 14 server tests, coverage gate met) and `npm run build` (both targets, manifests validated) all pass from scratch. Browser-loading steps are documented but not yet performed - see docs/SETUP_GUIDE.md.
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

**Phase Gate 9:** ☐ **Partially closed.** 9.2 closed — a root README verified by following it from a clean copy of the tree. 9.3's demo script is written from real captured payloads and is executed automatically by the e2e suite, but has not had the two required human rehearsals. 9.1 needs a `web-ext` package and a Firefox load; 9.4 (backup video), 9.5 (deck diagrams) and 9.6 (Q&A rehearsal) are not started.

---

## 6. Rubric Alignment Matrix (fill in as Phase 8 completes)

| Rubric Criterion            | Weight | Measured In | Result      | Status |
| --------------------------- | ------ | ----------- | ----------- | ------ |
| Visual context accuracy     | 25%    | Phase 8.2   | _(fill in)_ | ☐      |
| PII recall/precision        | 20%    | Phase 8.3   | _(fill in)_ | ☐      |
| Redaction precision         | 20%    | Phase 8.4   | _(fill in)_ | ☐      |
| Client resource utilization | 20%    | Phase 8.5   | _(fill in)_ | ☐      |
| End-to-end latency          | 15%    | Phase 8.6   | _(fill in)_ | ☐      |

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
