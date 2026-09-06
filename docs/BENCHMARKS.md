# PrivAgent Benchmarks

> **The rubric numbers now live in [`results.md`](../results.md)**, measured over a versioned
> dataset of 42 real captured pages. This document keeps the component-level measurements —
> the vision pass, the reasoning provider — which are about how the parts behave rather than
> how the system scores. Where the two overlap, `results.md` is the one to quote.

**Status: partially measured.** The vision pipeline has real numbers as of Stage 2
(2026-09-05); the five rubric lines are still scored in Stage 3 against one versioned
dataset. Everything below that carries a number was produced by a command in this repo, in
a real browser, and can be reproduced by running it.

## Rubric

| Criterion                              | Weight | Measured in         | Result                                                            |
| -------------------------------------- | -----: | ------------------- | ----------------------------------------------------------------- |
| Accuracy of visual context from screen |    25% | Phase 8.2 (Stage 3) | Component results only: OCR 99.4% CER-accuracy, faces 100% recall |
| PII detection recall and precision     |    20% | Phase 8.3 (Stage 3) | Structured PII 30/30 detected, 0/30 false positives               |
| Precision of redaction                 |    20% | Phase 8.4 (Stage 3) | 27/27 faces masked, 0 re-detected afterwards                      |
| Client-side resource utilization       |    20% | Phase 8.5 (Stage 3) | Vision pipeline +312–397 MB RSS (one device tier)                 |
| End-to-end latency                     |    15% | Phase 8.6 (Stage 3) | 445–494 ms warm without a model; ~10 s with the local model       |

The right-hand column is component evidence, not a rubric score. A rubric line needs one
number over one labelled dataset across many page types; these are measurements of parts,
on the fixtures each part was built against. They are here because they are real, and
because a reader deserves to know what is already known.

## Vision pipeline (Phase 2.5, measured 2026-09-05)

Command: `npx playwright test e2e/benchmark.spec.ts` from `extension/`, which writes
`test-results/vision-benchmark.json`. It drives the real extension in a real Chromium
browser against a fixture carrying one 260x320 photograph (one face) and one 420x180
canvas whose text exists only as pixels. Two runs, same machine:

| Measurement                              |      Run A |      Run B |
| ---------------------------------------- | ---------: | ---------: |
| Vision pass, warm (median of 7)          |     251 ms |     209 ms |
| — screenshot decode to CSS pixels        |      28 ms |      24 ms |
| — YuNet face detection, 640x640          |      97 ms |      81 ms |
| — OCR across 2 regions                   |     128 ms |      99 ms |
| Vision pass, warm (min / max)            | 222/417 ms | 173/464 ms |
| Vision pass, cold (first after install)  |    3293 ms |    1839 ms |
| Whole task, warm (perceive→reason→act)   |     494 ms |     445 ms |
| Whole task, cold                         |    4702 ms |    3408 ms |
| Browser RSS, extension loaded, no vision |     699 MB |     642 MB |
| Browser RSS, peak with vision            |    1011 MB |    1039 MB |
| **Attributable to vision**               | **312 MB** | **397 MB** |

Device: Windows 11, x64, software rendering (no discrete GPU in this environment).

### What these numbers mean, and what they do not

**The warm pass is ~250 ms and the cold pass is ten times that.** The cold figure is the
model load: a 232 KB detector on a 27 MB ONNX runtime, plus a 3.9 MB OCR core and 2 MB of
language data. The popup preloads all of it when it opens, so in normal use the first task
a user runs is warm. A first task run within a second of installing the extension is not.

**Memory is the weakest result here.** 312–397 MB attributable to vision is a lot, and it
is measured from the operating system rather than from `performance.memory`, which reports
the JS heap and would have shown a small fraction of it — nearly all of this is WebAssembly
linear memory. The likely reductions, in order of size: ship the WASM-only ONNX build
rather than the combined WebGPU/WASM one, hand the detector a pre-scaled 640x640 buffer
instead of a full-viewport screenshot, and release the OCR worker after an idle period.
None of those are done, and the number stands as measured.

**Both numbers describe one page shape on one device.** Two regions and one face is a
light load; a dashboard of twenty images would cost more OCR time. Phase 8.5 and 8.6
repeat this across the labelled dataset and a second device tier.

### Component accuracy already measured

| What                         | Result                         | Where                                            |
| ---------------------------- | ------------------------------ | ------------------------------------------------ |
| OCR character accuracy       | 99.4% mean over 10 samples     | `e2e/vision.spec.ts`, in-browser, canvas renders |
| Face detection recall        | 100% (27/27) at IoU ≥ 0.5      | `tests/faceDetection.eval.test.ts`, 20-image set |
| Face detection precision     | 100% (27/27), 0 on the control | same                                             |
| Structured PII detection     | 30/30 detected, 0/30 controls  | `tests/piiCorpus.test.ts`                        |
| Payload reduction vs raw DOM | 70.6–81.0% across 5 page types | `tests/contextBudget.test.ts`                    |

Each of these is measured against the fixtures that part was built with, which is exactly
why none of them is a rubric score.

## Reasoning (Phase 5.5, measured 2026-09-05)

Command: `npm run test:reasoner`, which runs `server/tests/test_ollama_live.py` against the
real model and writes `test-results/reasoner-benchmark.json`.

| Measurement                                    | qwen2.5:1.5b (Ollama, local) | Deterministic provider |
| ---------------------------------------------- | ---------------------------: | ---------------------: |
| Correct action over 10 task payloads           |                         8/10 |                  10/10 |
| Schema-valid Action JSON                       |                        10/10 |                  10/10 |
| Provider latency, median                       |                    13 731 ms |                  ~9 ms |
| Provider latency, min / max                    |            4 903 / 16 036 ms |                      — |
| `/reason` HTTP round trip (FastAPI TestClient) |                    10 707 ms |                      — |

A second run of the same suite on the same machine put the median at 10 400 ms, so treat
the figure as **10.4–13.7 s** rather than a single number; a 1.5B model on a CPU is not
repeatable to better than that.

### What these numbers mean

**This is the system's worst result, and it should not be dressed up.** Perception is
~250 ms warm and the whole client loop is ~450–500 ms. With a model in the loop, the model
_is_ the latency: reasoning is roughly twenty times everything else combined. Against the
rubric's 15% end-to-end latency line that is a bad score, and it is reported as one.

The gap between 13 731 ms of provider time and a 10 707 ms HTTP round trip is not the
server getting faster — it is run-to-run variance in the model. What it does establish is
that the server's own overhead (inbound validation, provider dispatch, outbound validation)
is inside the noise, in the tens of milliseconds. The latency is a model problem, not a
server problem.

**The honest options are all costs**: a smaller model (worse answers), a GPU (this machine
has none — the same reason WebGPU falls back to SwiftShader), or accepting that an agent
which reasons locally is slower than one that ships your screen to a datacentre. The
deterministic provider stays the default for exactly this reason, and the model is opt-in
via `PRIVAGENT_REASONER=ollama`.

**8/10, not 10/10, and the two misses are the interesting part.** Both are over-action: for
"open the settings menu" and "delete my account" on screens that offer neither, the model
clicked _something_ rather than declining. A model that would rather act than admit the
screen cannot serve the task is the failure mode this architecture has to survive, which is
why the client takes `max(server, local)` risk and never lowers it — the model also called
"pay the bill" low risk. The risk tier the model reports is treated as advice, not as a
decision.

Model choice was made by measurement, not reputation: `scripts/compare-reasoners.py` scores
candidates on the same ten payloads with the same prompt. `llama3.2:1b` scored 3/10 at a
~13 s median against qwen's 8/10.

## What is still unmeasured

Stage 2 removed both of the blockers this section used to describe: there is now a real
vision pipeline and a real model, so the 25% and 15% lines are measurable rather than
hypothetical. What is missing is no longer capability, it is **one dataset**.

Every number above was produced against the fixture the component was built with — one
photograph, one canvas, one portal page. A rubric line needs a single number over a
labelled set of many page types, produced by one command. That is Phase 8, and until it
runs, nothing above is a rubric score.

## The existing benchmark test does not count

`extension/tests/domWalker.benchmark.test.ts` asserts a median extraction latency under
50 ms across five fixtures, and it passes. Do not cite it.

It runs in jsdom with `HTMLElement.prototype.getBoundingClientRect` stubbed to a constant.
jsdom has no layout engine, so nothing is laid out and no geometry is computed — the test
measures `querySelectorAll` speed and object construction. On a real page, the dominant
cost is forced layout from reading `getBoundingClientRect` per element, which is exactly
the part being stubbed out.

It stays in the suite as a regression guard against pathological walker behaviour. It is
not a performance measurement.

## Planned methodology (Stage 3)

**Dataset.** At least 30 labelled screens in `tests/dataset/`, across forms, dashboards,
portals, e-commerce and SPAs, served as static local fixtures. Local fixtures over live
sites, deliberately: a benchmark that changes when a third-party site redesigns cannot be
compared across runs, and ground truth has to be stable to be scoreable.

Each fixture carries ground truth for its interactive elements, their roles and boxes, and
every PII span with its type.

**Visual context accuracy (25%).** Perceived elements matched against ground truth by IoU
with correct role; reported as precision, recall and F1, split by DOM-sourced versus
vision-sourced so the vision contribution is visible rather than hidden inside a DOM score.

**PII recall and precision (20%).** Per-type and aggregate, over every labelled span.
Recall is the number that matters most — a missed detection is a leak.

**Redaction precision (20%).** Of the spans that were redacted, how many were redacted
with the correct type and exact boundaries. The pre-Stage-1 defect where a card was
labelled `AADHAAR` and six characters of surrounding text were destroyed is precisely what
this metric catches; the regression suite in `privacy.test.ts` covers the specific cases,
and this measures the general behaviour.

**Client resource utilization (20%).** Resident set of the browser's own processes, taken
from the operating system, on two device tiers. Not `performance.memory` and not CDP's
`JSHeapUsedSize`: both exclude WebAssembly linear memory, which is where nearly all of this
pipeline's footprint lives, and reporting a JS heap figure would understate it by an order
of magnitude. Phase 2.5 established the method and the first tier's numbers.

**End-to-end latency (15%).** Wall clock per task, broken into perceive / filter / reason /
act, measured on real pages in a real browser — not in jsdom. Reported against **both**
providers, because the two answer different questions: the deterministic provider shows
what the client costs, and the local model shows what a user actually waits for.

**Reproducibility.** One command, output written to `results.md` with the commit hash,
device tier and dataset version, so a number can always be traced to the build that
produced it.
