# Gap Analysis — PrivAgent vs. SIH 2026 PS 26171

**Audited 2026-09-06, against the working tree at commit `b3cea1a` (+ uncommitted UI work).**

Method: every verdict below was re-derived for this document by running the code on this
machine on the audit date — not copied from `results.md` or from any earlier review. Where a
number here matches `results.md`, that is because the re-run reproduced it. The commands run,
in order: `npm run test:extension` (341 tests), `npm run test:server` (30 tests),
`npm run build` (both browser targets + manifest validation), `npx playwright test
e2e/dataset.spec.ts` (42 screens, real browser, wire capture), `npx vitest run
tests/datasetPii.eval.test.ts`, `npx playwright test e2e/profile.spec.ts`,
`npm run test:reasoner` (live Ollama). Raw outputs land in `test-results/*.json`.

**Honesty notes that apply to every number:**

- The 42-page dataset is **not held out** — the detectors were tuned against it
  (`results.md` § "What the dataset found"). Numbers are best read as "performance on the
  kind of page the system was hardened on".
- **Tier 2 is emulated** (2-core processor affinity on the same physical machine), not a
  second device.
- This machine has **no discrete GPU**: WebGPU falls back to SwiftShader, so every vision
  number is a software-rendering number. On GPU hardware the vision pass would be faster.
- The **default reasoning provider is a keyword matcher** (`DeterministicProvider`,
  `server/app/reasoning.py:31`), not an LLM. The real open-weight model (Qwen2.5-1.5B via
  local Ollama) is opt-in via `PRIVAGENT_REASONER=ollama`. Latency medians quoted "with the
  deterministic reasoner" are **not** LLM latencies; the LLM figures are stated separately.

---

## Rubric line 1 — Accuracy of visual context from screen (25%)

**PS requirement.** A local vision model (ViT or equivalent, WebGPU/WASM) reads the screen
state; the accuracy of the extracted visual context is scored.

**Current state.** Real and layered, not stubbed:

- Screenshot: `tabs.captureVisibleTab` from the background worker
  (`extension/src/background/service-worker.ts:99`, with quota retry at `:115`).
- Decode + inference in an extension-origin document: Chrome offscreen document / Firefox
  event page (`extension/src/background/vision.ts`).
- Face detection: YuNet ONNX (232 KB) via onnxruntime-web, WebGPU with WASM fallback
  (`extension/src/content/visionRuntime.ts:81`, `faceDetection.ts:59`).
- OCR: Tesseract WASM over DOM-invisible regions (`extension/src/content/ocr.ts`), fused
  into the element list **before** redaction (`content-script.ts:56` — vision text enters
  the Privacy Firewall by the same door as DOM text).
- All model/runtime assets vendored into the extension; zero CDN fetches
  (`extension/src/shared/assets.ts`, `scripts/vendor-assets.mjs`).

**"ViT or equivalent":** YuNet is a small CNN and Tesseract's engine is LSTM-based — neither
is a Vision Transformer. They are "equivalent" in the PS's functional sense (local models
evaluating screen state over WebGPU/WASM through ONNX Runtime), chosen because a ViT of
useful size would be 90 MB+ against a 20%-weighted resource budget. This is a defensible
engineering decision and is documented as such, but a judge reading "ViT" literally will not
find one; be ready to defend the trade in Q&A.

**Verdict: MET** (measured, real browser, real pixels).

**Evidence (re-run 2026-09-06, `npx playwright test e2e/dataset.spec.ts` →
`test-results/dataset-eval.json`):**

- Interactive elements vs Chrome's accessibility-tree oracle (3,964 ground-truth elements,
  3,820 scored after 144 withheld-by-design): **recall 94.0%, precision 90.5%, F1 92.2%**;
  role agreement 99.6%, name agreement 89.3% on matched pairs. Precision trails recall
  because the walker perceives real focusable `[role]`/`[tabindex]` containers the oracle
  omits — extra perception, not hallucination.
- Text that exists only as pixels: **90.1% mean character accuracy** this run (148 regions
  across 39 screens). The published figure is 97.3% (171 regions, 42 screens): OCR region
  reads vary with machine load because the vision pass carries a 15 s timeout, and this
  re-run shared the machine with a concurrent suite. Honest range across observed runs:
  **90–97%**, load-dependent — itself a finding worth stating.
- Faces: **42 detections / 42 labelled faces — recall 100%**, zero faces (or any pixel
  data) transmitted; every detection painted out of the buffer before OCR read it.
- 38 external requests attempted by the captured pages during evaluation, **0 allowed**.

## Rubric line 2 — Recall and precision of PII/sensitive-data detection (20%)

**PS requirement.** Detect sensitive/PII data (faces, passwords, PII text) client-side.

**Current state.**

- Structured detectors (regex + Luhn): Aadhaar, PAN, phone (mobile + landline, separator
  tolerant), email, card, OTP — `extension/src/content/privacy.ts:65`.
- Unstructured detectors (rule-based, confidence-graded): NAME + ADDRESS —
  `extension/src/content/unstructuredPii.ts`. Since 2026-09-06 the rules are the candidate
  generator of a **hybrid**: a quantized TinyBERT token-classification NER (14.5 MB int8,
  CoNLL-2003, vendored + digest-pinned) verifies every rule-detected NAME candidate in the
  extension-origin vision host and rejects candidates it sees no person in
  (`extension/src/content/nameVerifier.ts`, threshold calibrated offline in
  `scripts/eval-ner-verifier.py` → `test-results/ner-verifier-eval.json`). Verification
  only ever removes redactions; every failure path (model missing, host unreachable,
  malformed reply) keeps the mask.
- Faces: YuNet detection counts as sensitive-by-sight; every detection is pixel-painted out
  before OCR reads the buffer.
- Credential fields are excluded at extraction — `.value` is never read
  (`domWalker.ts`, verified by `tests/credentials.test.ts`).

**Verdict: MET — recall 100%, precision 93.1% (was 69.6% before the NER verifier).**

**Evidence (re-run 2026-09-06 after the hybrid landed, `npx vitest run
tests/datasetPii.eval.test.ts` → `test-results/dataset-pii*.json`):** over 4,483 real
strings from the 42 screens: recall **397/397 = 100%** on every labelled type (AADHAAR 42,
PAN 36, CARD 42, OTP 42, PHONE 83, EMAIL 70, NAME 42, ADDRESS 40) — the verifier rejected
zero labelled names; precision **93.1%** (522 detections, 36 false positives remaining, 87
detections of real PII the sites themselves publish, 2 right-value-wrong-type). The
verifier rejected 214 NAME candidates, cutting false-positive detections from 212 to 36.
Offline calibration kept all 31 reviewed site-published real names at the chosen threshold
(0.02; the lowest-scoring genuine name measured 0.053). Caveats stated plainly: the
threshold was tuned on this same non-held-out dataset, and the verifier covers NAME only —
the remaining 36 FPs are mostly ADDRESS/CARD/EMAIL rules plus NAME candidates the model
also reads as person-like ("Jan Suraksha").

## Rubric line 3 — Precision of redaction (20%)

**PS requirement.** Redact before any network request: faces blurred, passwords blacked
out, PII masked.

**Current state.** Stronger than the PS asks in two places, weaker in one:

- Passwords/credentials: never read at all (stronger than "blacked out").
- Faces: never transmitted in any form — pixels are painted out of the buffer before OCR,
  and no pixel data ever crosses the wire (stronger than "blurred").
- Text PII: tokenized to stable `[PII_<TYPE>_<NN>]` placeholders
  (`privacy.ts:166 ClientTokenMap`); reverse map never serialized.
- The network boundary is schema-enforced at both ends: the client refuses to POST anything
  failing `SanitizedContextSchema` (`background/reason.ts:24`), the server rejects unknown
  fields (`schemas.py Strict`, `extra="forbid"`).
- Former weak spot, fixed 2026-09-06: unstructured (name/address) values inside
  paragraph-length container text. Root causes found by reproducing each leak string
  through the redactor: (1) `trimToName` re-joined kept words with single spaces and then
  searched the original candidate, so any candidate whose words were separated by a
  newline — `"Arjun Menon\nIdentity"` — was silently dropped whole; (2) an ADDRESS
  candidate that greedily swallowed the phone number before it lost the entire span in
  `resolveSpans` when the phone won the overlap, leaking `27 MG Road, Kochi 682016` raw
  while the phone beside it was tokenized. Fixes: per-line unstructured detection
  (`innerText` newlines are element boundaries), offset-correct `trimToName`, and
  partial-span trimming in `resolveSpans` for fuzzy-boundary types (NAME/ADDRESS only —
  the tail of an address is still an address; the tail of a card number is not a card).

**Verdict: MET — 0 of 400 labelled values on the wire, structured and unstructured.**

**Evidence (re-run 2026-09-06 after the fixes, wire-captured by the recording proxy in
`e2e/dataset.spec.ts`):**

- 400 labelled PII spans across 42 screens; **0 structured values** (Aadhaar/PAN/card/OTP/
  phone/email) in any payload; **0 faces** transmitted; **0 unstructured leaks** (was 3).
  Element F1 92.7% in the same run — the fixes cost no perception accuracy.
- 594 elements redacted in place; 77 withheld for review (down from 688/217 before the
  NER verifier — the verifier releasing false-positive names returns whole elements to
  the reasoner that used to be withheld).
- The "passwords blacked out" requirement is exceeded: credential values are never read
  from the DOM at all, so there is nothing to black out — verified by
  `tests/credentials.test.ts` and on the wire (payloads carry the field's label only).

## Rubric line 4 — Client-side resource utilization (20%)

**PS requirement.** Lightweight client; resource use is scored.

**Current state.** Measured honestly from the OS (Win32 working set filtered to the test
browser's own profile dir — includes WASM linear memory that JS-heap metrics miss), on two
tiers (12-core, and 2-core emulated via processor affinity), now with a **no-extension
control run** and a **settled-after-idle sample**. Of the three reductions named in
`results.md`, the OCR worker idle release is implemented (self-terminates after 90 s idle
— `src/vision/analyze.ts scheduleOcrIdleRelease`, unit-tested); the WASM-only ORT swap is
deliberately not done (it would forfeit the WebGPU path the PS names; the single
`.jsep.wasm` binary keeps the WebGPU→WASM fallback a runtime choice), and the pre-scaled
detector input remains open (the full-viewport RGBA buffer is ~4 MB — not where the
memory is).

**Verdict: PARTIAL — peak is measured and now honestly attributed; retained footprint is
small after idle, but the in-task peak remains the project's weakest number.**

**Evidence (re-run 2026-09-07, `npx playwright test e2e/profile.spec.ts` →
`test-results/device-profile.json`):**

- **Control (same browser, same five pages, no extension): +49 MB.** The modern web is
  not what the tier deltas are made of; the pipeline is, and now that is measured rather
  than estimated.
- Tier 1 (12 cores): **533 → 1,580 MB peak (+1,047)** over five pages / twenty tasks;
  **settled to 725 MB (+192 over baseline)** after 95 s of idle — past the OCR worker's
  self-release window, with task pages closed. Tier 2 (2-core affinity): 598 → 1,421 MB
  (+823), settled 945 MB (+347).
- Reading: the ~1 GB figure is a **transient working peak** of a 20-task back-to-back
  workload (screenshot buffers, OCR crops, ORT arenas); what a session *retains* once the
  user stops asking is ~0.2–0.35 GB, dominated by the ORT runtime + models in the vision
  host. Both numbers are reported; neither is passed off as the other.
- Method is sound and conservative: OS working set (`Win32_Process`) filtered to the test
  browser's own profile directory, which **includes** WASM linear memory that
  `performance.memory`/CDP heap figures would miss by an order of magnitude.

## Rubric line 5 — Overall end-to-end latency (15%)

**PS requirement.** End-to-end latency of the provided task.

**Current state.** Warm-task latency with the deterministic provider is ~1 s; with the real
local model the reasoning step alone is ~10–14 s on this CPU-only machine — the model is
the latency. The "rest" segment (DOM walk, firewall, context build, risk gate, execution)
now exceeds the vision pass on most pages and is unoptimized.

**Verdict: PARTIAL — ~1 s pipeline MET, but the honest end-to-end number with a real LLM in
the loop is ~11–15 s and the PS demo must use the real LLM.**

**Evidence (re-run 2026-09-06):**

- Warm task, deterministic provider (`e2e/profile.spec.ts`): tier 1 median **1,058 ms**
  (vision 395–1,670 ms; reason 7–17 ms; "rest" 455–1,618 ms), tier 2 median **2,298 ms**.
  Published idle-machine medians were 960 / 1,055 ms — same shape, load-sensitive.
- Live local model (`npm run test:reasoner`, qwen2.5:1.5b on Ollama, CPU): **8/10 correct,
  median 14,246 ms, max 33,767 ms** per reasoning step; full `/reason` round trip 10,262 ms.
  Both misses are failures to answer `none` (it clicked something on "open the settings
  menu" and "delete my account" — the risk gate is what stands between that and harm).
- So the honest end-to-end number with the PS-required real LLM is **~11–15 s per task**,
  and the model is >90% of it.

---

## Required component 1 — Client-side extension with local vision (Chrome + Firefox)

**PS requirement.** Browser extension for Chrome and Firefox running a local vision model
via WebGPU/WASM.

**Current state.**

- Chrome MV3 build: **verified live** — `e2e/` suites (24 Playwright tests) load the real
  unpacked `dist/chrome` into a real Chromium and drive the full pipeline.
- Firefox MV3 build: **verified live** (2026-09-06) — real Firefox 155.0.1 with
  `extension/dist/firefox` installed as a temporary add-on via Selenium/geckodriver
  (`scripts/verify-firefox.py`), driven against local fixture pages with every `/reason`
  request wire-captured by a recording proxy.
  - **Act 1 (DOM pipeline):** 6 elements perceived → 3 matched PII detectors → 5 values
    tokenized → 4 marks transmitted → server proposed `click` → executed — the fixture
    page's own DOM shows `downloaded`, proving real actuation.
  - **Act 2 (event-page vision path — `background/vision.ts:119`):** a canvas-only page
    (phone number painted in pixels, absent from the DOM) — vision read 1 region in
    7,433 ms (decode 21 / detect 7,377 / ocr 35 ms), and the painted number reached the
    wire only as `[PII_PHONE_01]`. This exercises the Firefox-specific host (event page
    analysis document instead of Chrome's offscreen document) and `captureVisibleTab`.
  - **Wire capture:** 2 requests total; **0 raw planted PII values** (phone ×2, email,
    Aadhaar, card) found anywhere on the wire; redaction tokens present.

**Verdict: MET — both Chrome and Firefox verified live.**

**Evidence:** `test-results/firefox-verification.json` (`"verdict": "PASS",
"vision_verdict": "PASS"`, Firefox 155.0.1, wire_requests 2, wire_raw_pii []);
screenshots `test-results/firefox-act1-popup.png`, `firefox-act1-page.png`,
`firefox-act2-popup.png`. Reproducible via `python scripts/verify-firefox.py`.
Caveat: fixture pages, not live web sites; one measured vision pass (7.4 s detect
stage under WASM in Gecko) is a single sample, not a distribution.

## Required component 2 — Privacy filter before any network request

**Verdict: MET (verified on the wire).** See rubric lines 2–3. The one payload shape that
can cross the network is `SanitizedContext`; it is validated immediately before `fetch`
(`background/reason.ts:24-31`) and carries no pixels, no raw DOM, no URLs, no field values.
The audit trail lives in IndexedDB on the extension origin and re-runs the PII detectors
over its own detail strings at write time, throwing rather than persisting a match
(`background/audit.ts`, `assertPrivacySafe`).

## Required component 3 — Server: sanitized context in, redaction-aware, offline LLM, actions out

**PS requirement.** Server receives only sanitized context, understands the redaction
scheme, runs an offline-deployable open-source LLM/VLM, returns actionable commands.

**Current state.**

- FastAPI server, `/reason` endpoint, request and response schema-validated
  (`server/app/main.py:36`).
- Redaction-scheme awareness: SYSTEM_PROMPT rule 5 tells the model exactly what
  `[PII_NAME_01]`-style tokens are and how to treat them (opaque, clickable, never guess) —
  `server/app/prompt.py:51`. The server never sees or maps raw values (by design — the
  token map never leaves the client).
- Real LLM: Qwen2.5-1.5B (open-weight, Apache-2.0) on local Ollama with constrained JSON
  decoding, semantic validation of the returned action (hallucinated mark ids rejected,
  one retry, then a safe `none`) — `server/app/ollama.py`. Offline-deployable: yes — local
  runtime, no external API.
- **But the default provider is a keyword matcher** (`DeterministicProvider`). CI and the
  latency medians use it. Anyone evaluating the repo without setting
  `PRIVAGENT_REASONER=ollama` is not seeing an LLM.

**Verdict: MET, with the caveat that the LLM is opt-in rather than default.**

**Evidence:** 30 server tests pass (2026-09-06); live benchmark
`npm run test:reasoner` (2026-09-06): qwen2.5:1.5b @ prompt 1.1 scores **8/10** on the
task-accuracy harness at median 14.2 s; the two misses chose an element when `none` was
correct, and both would be caught or confirmed by the client-side risk gate.

## Required component 4 — End-to-end task demo

**Verdict: MET on Chrome (rehearsed, measured), NOT DONE as a human-run demo.**
`npm run demo:rehearse` exists and passes (5-act scripted demo against the real extension +
real server; `test-results/demo-rehearsal.json` shows two full passes). `results.md` and
`README.md` both state plainly that no human has rehearsed the demo aloud.

## Required component 5 — Single-shot vs. agentic loop (scope note)

The PS demands one demonstrated task end-to-end; PrivAgent currently executes exactly **one
action per task** (`content-script.ts:48` → one `/reason` call → one execution). There is no
multi-step loop, no task-completion signal in the Action vocabulary
(`click|type|scroll|navigate|none` — `schemas/privagent.schema.json:7`), no step history,
and no bot-detection handling (zero hits for captcha/challenge markers in the source).
Multi-step tasks (the "universal agentic browsing" extension) are **NOT STARTED** — by
design, they are an additive layer being built on top of PS compliance, not a PS gap.

---

## Verdict summary

| Line | Weight | Verdict | Measured (re-run 2026-09-06) |
| --- | --- | --- | --- |
| 1. Visual context accuracy | 25% | **Met** | F1 92.2% · OCR 90.1% (this run; 90–97% observed) · faces 42/42 |
| 2. PII detection P/R | 20% | **Met** | Recall 100% (397/397) · Precision 93.1% (NER-verified hybrid) |
| 3. Redaction precision | 20% | **Met** | 0/400 leaked on the wire (structured, unstructured, faces) |
| 4. Client resources | 20% | **Partial** (attributed) | control +49 MB · t1 peak +1,047 / settled +192 · t2 peak +823 / settled +347 |
| 5. E2E latency | 15% | **Partial** | ~1.1 s deterministic · ~11–15 s with real local LLM |
| Chrome extension | — | **Met** | 24 e2e tests, real browser |
| Firefox extension | — | **Met** | live-verified: Firefox 155.0.1, both pipelines, 0 raw PII on wire |
| Privacy filter pre-network | — | **Met** | wire-verified |
| Server (redaction-aware, offline OSS LLM) | — | **Met** (LLM opt-in) | 30 tests; live Qwen2.5-1.5B |
| E2E task demo | — | **Met** (unrehearsed by humans) | demo-rehearsal.json, 2 passes |
| Multi-step agentic loop (extension goal) | — | **Not started** | — |

Nothing audited was **Broken** (code that runs and silently produces wrong output). The
closest candidates — the `aria-label`-hides-painted-text exposure and the 3 long-container
unstructured leaks — are documented failure modes with measured sizes, not silent ones.
