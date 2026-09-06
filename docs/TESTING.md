# PrivAgent Testing

Last run: 2026-09-04 · **210 client + 14 server + 7 browser tests, all passing.**

```bash
npm test                              # everything CI runs
npm run test:extension                # vitest + coverage gate
npm run test:server                   # pytest
npm run test:e2e --prefix extension   # Playwright, real Chromium + real extension
```

## Why these suites are shaped this way

An earlier build had 41 green tests, clean lint and clean types while the pipeline was
entirely disconnected — no module imported another, and no client had ever called the
server. Every unit passed because every unit mocked its neighbour.

Two suites exist specifically to make that impossible to repeat:

- `tests/loop.test.ts` drives the whole content-side chain with only the extension
  messaging boundary mocked.
- `tests/integration/reason.integration.test.ts` spawns the **real** FastAPI app and calls
  it over **real** HTTP with the **real** `fetch`.

## Client suites

| Suite                               | Tests | What it covers                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `piiCorpus.test.ts`                 |    64 | **Phase 3.1 criterion.** 30/30 structured PII samples detected, 0/30 false positives on near-miss controls, no residual after redaction, controls left byte-identical.                                                                                                                                  |
| `privacy.test.ts`                   |    18 | **Primary regression suite.** Overlapping/adjacent PII of different types, span resolution, reading-order numbering, token reuse, Luhn scoring, confidence gate.                                                                                                                                        |
| `contextBudget.test.ts`             |    12 | **Phase 4.3/4.4 criteria.** 70.6–81.0% payload reduction across five site types; 25 serialized payloads with zero raw PII.                                                                                                                                                                              |
| `confirm.test.ts`                   |     6 | The prompt's closed shadow root is unreadable from the page; `Escape` denies, bare `Enter` does not approve, listeners detach on settle.                                                                                                                                                                |
| `screenState.test.ts`               |    16 | Generated Zod validators: 5 site types, malformed payloads, camelCase rejection, `Action` parsing incl. extra-field rejection.                                                                                                                                                                          |
| `actions.test.ts`                   |    25 | Risk tiers and execution. Includes the **Phase 6.1 criterion**: a labelled 15-action table across all three tiers, with the same verb at different confidences and target sensitivities. Plus `max(server, local)` escalation, all four action types, stale marks, missing params, unsupported targets. |
| `credentials.test.ts`               |    10 | **Password-leak regression suite.** 7 credential field shapes, a full login form, and proof no `.value` is read for ordinary fields either.                                                                                                                                                             |
| `ocr.test.ts`                       |    10 | OCR wrapper contract. **Injects a fake worker — has never run real Tesseract.**                                                                                                                                                                                                                         |
| `domWalker.test.ts`                 |     9 | Roles, ARIA, labels, bbox, live refs, and 6 perceivability cases (`display:none`, `visibility:hidden`, `hidden`, `aria-hidden`, zero-size).                                                                                                                                                             |
| `loop.test.ts`                      |     5 | **End-to-end content loop**: perceive → redact → reason → validate → act → audit; denial path; local risk escalation; stale target.                                                                                                                                                                     |
| `reason.test.ts`                    |     5 | Reasoner client: pre-flight schema check, unreachable, rejected, malformed response.                                                                                                                                                                                                                    |
| `domWalker.benchmark.test.ts`       |     5 | Extraction latency. **Not a meaningful benchmark — see caveat below.**                                                                                                                                                                                                                                  |
| `audit.test.ts`                     |     4 | IndexedDB store, stage ordering, PII write guard.                                                                                                                                                                                                                                                       |
| `pipeline.test.ts`                  |     4 | Redaction wiring, `pii_type` labelling, counts, shared token map.                                                                                                                                                                                                                                       |
| `contextBuilder.test.ts`            |     4 | Set-of-Mark tagging, mark→element mapping, relevance filter, contiguous numbering.                                                                                                                                                                                                                      |
| `fusion.test.ts`                    |     4 | IoU dedup, DOM precedence, threshold. Built but **not yet wired** — nothing produces vision elements.                                                                                                                                                                                                   |
| `visionRuntime.test.ts`             |     3 | WebGPU→WASM backend selection.                                                                                                                                                                                                                                                                          |
| `reason.integration.test.ts`        |     3 | **Real HTTP round trip** against a spawned uvicorn: valid action, 422 on an extra field, provider reported.                                                                                                                                                                                             |
| `faceDetection.test.ts`             |     2 | Throws `CapabilityUnavailableError` when the API is absent; normalizes boxes when present.                                                                                                                                                                                                              |
| `visionRuntime.integration.test.ts` |     1 | Executes a real ONNX graph on the WASM backend. **The graph is an Identity no-op, not a perception model.**                                                                                                                                                                                             |

## Server suites

| Suite                 | Tests | What it covers                                                                                                   |
| --------------------- | ----: | ---------------------------------------------------------------------------------------------------------------- |
| `test_reason.py`      |     8 | Valid action, declines rather than guessing, 4 malformed payloads, extra-field rejection, provider in isolation. |
| `test_schemas.py`     |     4 | Vision elements require confidence, DOM elements do not, targeted actions require a mark, confidence bounds.     |
| `test_health.py`      |     1 | Status and active provider.                                                                                      |
| `test_health_http.py` |     1 | Real uvicorn over real HTTP via `curl`.                                                                          |

## Coverage

Enforced by `vitest.config.ts`; CI fails below the gate.

| Metric     | Measured | Gate |
| ---------- | -------: | ---: |
| Statements |   86.98% |  86% |
| Branches   |   76.17% |  75% |
| Functions  |   81.31% |  80% |
| Lines      |   89.59% |  89% |

Gates sit just under the measured numbers — a ratchet, so any regression fails. They are
raised as coverage improves, not set aspirationally.

Excluded: `schemas/generated.ts` (generated; guarded by the drift check),
`background/service-worker.ts` and `ui/popup.ts` (browser entry points, covered by e2e).

The remaining gap is concentrated in `ocr.ts` and `visionRuntime.ts` — the Stage 2
modules that are not yet wired into the pipeline.

## Browser end-to-end

`extension/e2e/loop.spec.ts` loads the real unpacked extension into a real Chromium-based
browser alongside a real FastAPI server and a served fixture page.

**Status: passing — 7 tests.** The suite drives the real popup UI (not the service
worker, whose handle goes stale when an MV3 worker idles out) against a served fixture
page and a live FastAPI server behind a recording proxy.

| Test                                              | What it proves                                                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| runs the full loop and actuates the page          | The fixture's own click handler fires — the agent really acted, it did not merely report.                                                                   |
| renders the six-stage audit trace                 | The popup shows observe → detect_pii → redact → reason → validate → act.                                                                                    |
| writes the audit trail to the extension origin    | The page's `localStorage` holds only what the page wrote, and `privagent` is absent from the page's `indexedDB` — while the extension origin has the trail. |
| transmits no credential value and no raw PII      | The captured `/reason` body contains no password, phone, email, Aadhaar or card value.                                                                      |
| transmits a task-relevant value as a token        | `"Request callback on [PII_PHONE_01]"` crosses the wire; the number does not.                                                                               |
| pauses on a high-risk action and honours a denial | A server response claiming `"risk": "low"` for a `navigate` is scored `high`, prompts, is denied, and no navigation occurs.                                 |
| renders a complete trace for three separate tasks | All six stages present for each of three consecutive tasks.                                                                                                 |

The payload is captured by a recording proxy in front of the server rather than by
Playwright route interception: the `/reason` call is made from the service worker, which
page and context routing does not reliably intercept — and the wire is the more honest
place to assert what left the browser anyway.

**Firefox:** Playwright cannot load extensions in Firefox. Firefox needs a separate
`web-ext run` smoke check, which is not yet written. What _is_ verified today is that the
Firefox build produces a manifest with the event-page background shape Firefox MV3
requires (`scripts/verify-manifests.mjs`).

**Browser selection:** the suite prefers Playwright's bundled Chromium and falls back to a
locally installed Edge or Chrome when it is absent, so it is runnable without a 150 MB
download. Override with `PRIVAGENT_E2E_CHANNEL`.

## Evaluation suites

Four suites exist to produce numbers rather than to catch regressions, and they are named
separately because they are slow and because a number is only worth anything when you know
which command made it. All of them write JSON into `test-results/`.

| Command                 | Suite                              | Answers                                      | Output                    |
| ----------------------- | ---------------------------------- | -------------------------------------------- | ------------------------- |
| `npm run eval:dataset`  | `e2e/dataset.spec.ts`              | Visual-context accuracy, redaction precision | `dataset-eval.json`       |
| (part of `npm test`)    | `tests/datasetPii.eval.test.ts`    | PII recall and precision                     | `dataset-pii*.json`       |
| `npm run eval:profile`  | `e2e/profile.spec.ts`              | Resource use and latency, two device tiers   | `device-profile.json`     |
| `npm run test:reasoner` | `server/tests/test_ollama_live.py` | The real model's accuracy and latency        | `reasoner-benchmark.json` |

Two properties of these suites are deliberate and worth keeping.

**The PII evaluation refuses to grade itself.** Every detection outside a labelled span has
to carry a hand-written verdict in `tests/dataset/pii-review.json`, and the test fails if any
detection is unreviewed. Change a detector and new values appear there; the honest response
is to read them and extend the review file, not to widen a tolerance. It is what keeps
"precision 69.8%" from being a number nobody checked.

**The dataset evaluation blocks the network.** Every request that is not to `127.0.0.1` is
aborted for the duration of the run. That keeps the measurement reproducible — a snapshot
that quietly fetched a live font would drift between runs — and it means a benchmark of a
privacy tool cannot itself talk to anyone.

### Regenerating the dataset

```bash
npm run dataset:capture     # needs the internet; produces a DIFFERENT dataset each time
npm run dataset:annotate    # offline and deterministic; re-labels the committed snapshots
```

Annotation is seeded per screen, so re-running it reproduces the same labelling byte for
byte. Capture is not reproducible, because the sites change — the committed snapshots are the
versioned artefact, and the capture script is how they were made rather than something to run
before measuring. Both run **headed**: a headless Chromium driven through Playwright's
viewport emulation hides the scrollbar, the page then lays out 15 pixels wider than it does in
the browser the extension actually runs in, and on a centred layout that moved every
ground-truth box by eight pixels — which reported element recall as 52% for a system that
scores 94%.

## Demo rehearsal

```bash
npm run demo:rehearse
```

`e2e/demo.spec.ts` executes `docs/DEMO_SCRIPT.md` twice in a row and asserts every number the
document quotes, so the script cannot drift from the system. It also records
`docs/demo/privagent-demo.webm`, which is the backup for a failed live demo. Both passes must
produce identical privacy summaries: a demo whose numbers move between rehearsals will move
on stage.

## Known-weak tests

Recorded rather than quietly relied on:

| Test                                | Weakness                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domWalker.benchmark.test.ts`       | Runs in jsdom with `getBoundingClientRect` stubbed to a constant. jsdom has no layout engine, so it measures `querySelectorAll` speed, not extraction latency. Real numbers need Stage 3. |
| `ocr.test.ts`                       | Injects a fake worker. Real `eng.traineddata` has never been loaded, so the stated character accuracy is unmeasured.                                                                      |
| `visionRuntime.integration.test.ts` | Runs a 100-byte ONNX Identity graph. It proves the runtime executes; it perceives nothing.                                                                                                |

## CI

`.github/workflows/ci.yml` on every push and PR: schema drift check → lint → typecheck →
format → client tests with coverage → server tests → both browser builds → manifest
validation → artifact upload. Python is installed **before** the client tests because the
integration test spawns the real server.

A second CI job runs the browser suite under `xvfb-run`, kept separate so a
browser-environment failure cannot be mistaken for a code failure in the main job.
