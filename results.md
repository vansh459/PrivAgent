# PrivAgent — measured results

**Build 0.3.0 · measured 2026-09-06 · dataset v1.0 (42 screens)**

Every number here was produced by a command in this repository, on the machine described
below, against one versioned dataset. Nothing is projected, extrapolated or rounded in the
system's favour. Where a result is bad, it is here at the same size as the good ones.

---

## The five rubric criteria

| Criterion                                  | Weight | Result                                                                                                                                                       | Where it comes from                                                |
| ------------------------------------------ | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| **Accuracy of visual context from screen** |    25% | **F1 92.2%** on interactive elements (P 90.4 / R 94.0) · **97.3%** character accuracy on text that exists only as pixels · **100%** recall on labelled faces | `npx playwright test e2e/dataset.spec.ts`                          |
| **PII detection recall and precision**     |    20% | **Recall 100%** (397/397 labelled spans) · **Precision 69.8%** (490/702 detections) over 4 483 real strings                                                  | `npx vitest run tests/datasetPii.eval.test.ts`                     |
| **Precision of redaction**                 |    20% | **0 of 400** identifiers or contact details reached the wire, across 42 payloads · **0 faces** ever transmitted · 3 unstructured (name/address) values did   | `npx playwright test e2e/dataset.spec.ts`                          |
| **Client-side resource utilization**       |    20% | **+907 MB** resident on tier 1, **+963 MB** on tier 2 (emulated) over a five-page session                                                                    | `npx playwright test e2e/profile.spec.ts`                          |
| **End-to-end latency**                     |    15% | **960 ms** median warm task on tier 1, **1 055 ms** on tier 2 — with the deterministic reasoner. **~10 s** with the local model                              | `npx playwright test e2e/profile.spec.ts`, `npm run test:reasoner` |

Machine: Windows 11, x64, 12 logical processors, **no discrete GPU** — WebGPU falls back to
SwiftShader, so every vision figure below is a software-rendering figure.

---

## What was measured against

[`tests/dataset/`](./tests/dataset/README.md), version 1.0: **42 real public web pages**,
captured and frozen as inert offline snapshots, across 13 government portals, 6 finance
sites, 8 e-commerce pages, 5 forms, 4 SPAs and 6 dashboards. They carry **3 964
ground-truth interactive elements** from Chrome's own accessibility tree, **400 injected
synthetic PII spans**, **42 labelled faces** and **84 labelled painted-text regions**.

Three properties of that dataset decide how much any number here is worth, and they are
stated in full in its README:

1. **The pages are real; the people in them are not.** A logged-out public page contains no
   personal data, so the PII is injected from twelve synthetic personas — format-valid
   Aadhaar numbers that were never issued, published test card numbers, invented names.
   Using a real person's identifiers to benchmark a redaction tool would be indefensible.
2. **The element ground truth is an independent oracle, not our own walker.** It is Chrome's
   accessibility tree, filtered to actionable roles, boxed with `DOM.getBoxModel`. It is
   independent of this project's code but not of the DOM.
3. **The detectors were improved in response to this dataset.** These are not held-out
   numbers. What the dataset found, and what was changed because of it, is in
   [Findings](#what-the-dataset-found) below — that history is the most useful part of this
   document.

---

## 1. Visual context accuracy (25%)

Perception is measured in three parts, because a single number would hide which half of the
system is doing the work.

### Interactive elements, against the accessibility oracle

| Measure                          | Result    |
| -------------------------------- | --------- |
| Ground-truth elements            | 3 964     |
| Withheld by design (carried PII) | 144       |
| Scored against                   | 3 820     |
| Transmitted marks                | 3 974     |
| Matched at IoU ≥ 0.5             | 3 592     |
| **Recall**                       | **94.0%** |
| **Precision**                    | **90.4%** |
| **F1**                           | **92.2%** |
| Role agreement on matched pairs  | 99.6%     |
| Name agreement on matched pairs  | 89.3%     |

Precision is below recall because PrivAgent perceives more than the accessibility tree
does: it walks `[role]` and `[tabindex]` containers that Chrome's accessibility computation
ignores, so it reports 5 049 elements where the oracle lists 3 964. Those extra elements are
not hallucinations — they are real nodes a user can focus — but they are not in the oracle,
so they score as false positives. The 11% name disagreement is mostly the same thing seen
from the other side: a container's text is the concatenation of its children's.

### Text that exists only as pixels

**97.3% mean character accuracy** across all 42 screens, on a 320×70 region rendered to an
image with no text node, no `alt` and no attribute anywhere in the DOM. The agent read it
off the screenshot, through OCR, and it arrived in the payload. 171 visual regions were read
in total across the set, at a median of 274 ms per page.

### Faces

**48 detections against 42 labelled faces.** Every labelled face was found: recall 100%. The
six extra detections are not false positives — five were verified by eye against the
reference screenshots as photographs of real people that those sites publish (a child on the
UIDAI homepage, three people in a SEBI banner, a family in an ICICI hero image); the sixth,
on the MCA portal, is against an illustrated banner and could not be confirmed either way.
Face precision is therefore **≥ 47/48 (97.9%)**.

Worth recording against that: the ICICI hero photograph contains three visible faces and the
detector found one of them. Detection on real photographs, at angles and partial occlusion,
is materially worse than on the composited portraits the recall figure is measured against.

---

## 2. PII detection recall and precision (20%)

Measured over **4 483 strings** — every string the DOM walker would be handed on all 42
screens. 397 carry an injected value with a known type; the other 4 086 are whatever those
real pages actually say.

| Type    | Recall           |
| ------- | ---------------- |
| AADHAAR | 42/42 100%       |
| PAN     | 36/36 100%       |
| CARD    | 42/42 100%       |
| OTP     | 42/42 100%       |
| PHONE   | 83/83 100%       |
| EMAIL   | 70/70 100%       |
| NAME    | 42/42 100%       |
| ADDRESS | 40/40 100%       |
| **All** | **397/397 100%** |

Three of the 400 injected spans landed on elements the walker does not perceive at all, so
the firewall was never handed them; they are excluded from detection recall and counted as a
perception result instead.

**Precision: 69.8%** — 490 of 702 detections were of something that really is personal data.
Every one of the 305 detections outside a labelled span was read against the page it came
from and given a verdict in `tests/dataset/pii-review.json`:

| Verdict                            | Count |
| ---------------------------------- | ----: |
| Real PII the site itself publishes |    91 |
| Real PII, wrong type on the token  |     2 |
| False positive                     |   212 |

The 91 "real" detections are worth naming, because they are the system working on data
nobody planted: **eleven real PANs printed in the income-tax portal's own recovery
notices**, seven published grievance-cell email addresses, two helpline numbers, a real
office address, and 47 detections of people named on SEBI enforcement orders, RBI speeches
and MCA notices.

**212 false positives, and 202 of them are one detector.** The rule-based NAME recogniser
fires on Title-Case noun phrases — "Appeal No", "Fixed Deposit", "Winners Announcement". A
shape-only name detection scores in the review band, so the element carrying it is withheld
from the reasoner rather than sent with a wrong token: the failure is lost capability, not a
leak. It is still the clearest argument in this document for replacing the rules with a
model (see [the trade-off](#the-ner-trade-off)).

---

## 3. Redaction precision (20%)

The criterion is zero unredacted critical fields. Measured on the bytes that actually left
the browser, captured on the wire by a recording proxy, for all 42 screens:

| Measure                                                        | Result                            |
| -------------------------------------------------------------- | --------------------------------- |
| Labelled PII spans on the pages                                | 400                               |
| Aadhaar / card / OTP / PAN / phone / email values in a payload | **0**                             |
| Faces described to the server                                  | **0** (48 detected, all withheld) |
| Face pixels painted out before OCR read the buffer             | every detection                   |
| Name / address values in a payload                             | 3                                 |
| Elements redacted in place                                     | 691                               |
| Elements withheld entirely for review                          | 217                               |
| External requests made by the pages during evaluation          | **0** (38 attempts blocked)       |

The three that got through are two names and one address, all inside long container
elements whose text runs to hundreds of characters. The unstructured recogniser only accepts
shape-only evidence inside short prose, so in a paragraph-length string a name with no label
and no gazetteer hit is not detected. Structured identifiers are unaffected — a regex does
not care how long the string is.

A PHONE number rendered **only as pixels** was read by OCR, passed through the firewall and
transmitted as `[PII_PHONE_nn]` on every screen. That is the whole architecture in one line:
vision output enters the Privacy Firewall by the same door as DOM text, so it cannot bypass
it.

---

## 4. Client resource utilization (20%)

| Measure                                     | Tier 1 (12 cores) | Tier 2 (2 cores, emulated) |
| ------------------------------------------- | ----------------: | -------------------------: |
| Resident memory at launch, extension loaded |            529 MB |                     539 MB |
| Peak after five pages and twenty tasks      |          1 436 MB |                   1 502 MB |
| **Attributable to the session**             |       **+907 MB** |                **+963 MB** |

**This is the system's second-worst result and the number is not flattering.** Roughly
300–400 MB of it is the vision pipeline itself, measured in isolation in Phase 2.5 on a
single light fixture; the rest is five real pages of a modern web rendered in one browser.
The figure is taken from the operating system (`Win32_Process` working set, filtered to this
browser's own profile directory), not from `performance.memory` or CDP's `JSHeapUsedSize` —
both exclude WebAssembly linear memory, which is where nearly all of the pipeline's
footprint lives, and would have understated it by an order of magnitude.

The reductions available, in order of size, none of them done: ship the WASM-only ONNX build
instead of the combined WebGPU/WASM one (27 MB of runtime), hand the detector a pre-scaled
640×640 buffer instead of a full-viewport screenshot, and release the OCR worker after an
idle period.

**Tier 2 is emulated and is labelled as such wherever it appears.** There is one machine
here. Tier 2 confines every process of the browser to two logical processors through Windows
processor affinity — a real constraint on real work, applied to the whole browser rather
than to a single renderer, which is why it is not CDP's `Emulation.setCPUThrottlingRate`:
that throttles the page's renderer and would leave the offscreen document where all the
vision runs at full speed. It is still not a second physical device: a mid-tier laptop also
differs in memory bandwidth, cache, storage and thermal headroom.

---

## 5. End-to-end latency (15%)

Five real tasks on five real pages, four runs each, first discarded as cold.

### Tier 1 — 12 cores

| Page                       |    Cold |       Warm | = vision | + reason | + rest | Regions |
| -------------------------- | ------: | ---------: | -------: | -------: | -----: | ------: |
| UIDAI portal               | 3 527ms |   1 133 ms |   284 ms |    10 ms | 839 ms |       3 |
| ICICI Bank                 | 1 012ms |   2 245 ms | 1 336 ms |    19 ms | 890 ms |       4 |
| Web Scraper (laptops grid) | 1 282ms |     597 ms |   323 ms |    10 ms | 264 ms |       3 |
| DemoQA practice form       |   495ms |     526 ms |   264 ms |     3 ms | 259 ms |       4 |
| AdminLTE dashboard         |   521ms |     960 ms |   290 ms |     3 ms | 667 ms |       5 |
| **Median**                 | 1 012ms | **960 ms** |   290 ms |    10 ms | 667 ms |         |

### Tier 2 — 2 cores (emulated)

| Page                       |    Cold |         Warm | = vision | + reason |   + rest |
| -------------------------- | ------: | -----------: | -------: | -------: | -------: |
| UIDAI portal               | 3 251ms |     1 026 ms |   251 ms |     4 ms |   771 ms |
| ICICI Bank                 | 2 036ms |     3 206 ms | 1 688 ms |    17 ms | 1 501 ms |
| Web Scraper (laptops grid) | 1 117ms |     1 210 ms |   327 ms |     7 ms |   876 ms |
| DemoQA practice form       | 1 139ms |     1 055 ms |   392 ms |     7 ms |   656 ms |
| AdminLTE dashboard         | 1 015ms |     1 048 ms |   359 ms |     5 ms |   684 ms |
| **Median**                 | 1 139ms | **1 055 ms** |   359 ms |     7 ms |   684 ms |

Cutting the machine from twelve cores to two costs about **10% of median task time**. That
is a better result than it looks and has a specific cause: ONNX Runtime here is
single-threaded, because a content script is never cross-origin isolated and the pipeline
runs without `SharedArrayBuffer`. A pipeline that cannot use more than one core loses little
when the other eleven are taken away. It also means the tier-1 figure is not benefiting from
parallelism that a weaker machine would lack.

**The `rest` column — the DOM walk, the privacy firewall, context building, the risk gate
and execution — is now larger than the vision pass on most pages.** On real portals with
hundreds of interactive elements it dominates. That is the opposite of what the Phase 2.5
fixture suggested, and it is where the next optimisation belongs.

### With a real model in the loop

Everything above uses the deterministic provider, which answers in 3–19 ms and is the
default. With the local open-weight model — Qwen2.5-1.5B on Ollama, CPU — the reasoning step
alone takes a **median 10.4–13.7 s** (`npm run test:reasoner`), against a ~1 s budget for
everything else. **With a model in the loop, the model is the latency.** The honest options
are a smaller model, a GPU this machine does not have, or accepting that an agent which
reasons locally is slower than one that ships your screen to a datacentre.

---

## What the dataset found

The most valuable output of Phase 8 was not the table at the top. It was five defects that
only real pages could expose, all of which were fixed and re-measured. These numbers are
therefore **not held out**: the detectors were tuned against this dataset, and a held-out
set is the obvious next piece of work.

**1. Title Case is not a name.** The unstructured recogniser scored 100% precision on
hand-written fixtures and fired **1 703 times** on 4 086 real strings — "Simple Tables",
"Mailbox Pages Extras", "Plugin Documentation". Navigation is written in Title Case, and two
capitalised words is the shape of a menu item at least as often as a person. Shape-only
evidence is now accepted only inside short prose, which has lowercase words in it. False
positives fell to 202.

**2. `Main` is a word, `Road` is an address.** A single locality word was enough to call a
line a postal address, and `main`, `near`, `layout`, `cross` and `block` were all in that
list — so "Skip to main content" and "Find An ATM Near You" were masked as somebody's home
address, 77 times. The list is now split into street words that are evidence and locality
words that are only support.

**3. Phone numbers are written with spaces in them.** The regex required ten unbroken digits
after an optional `+91`, which is how a form stores a number and not how a page displays
one. Recall on labelled phone numbers was **48%**: `+91 98123 45670` and `+91-98765-43210`
were missed on the internal separator alone, and Indian landlines entirely. With separators
and STD codes handled, recall is 100%.

**4. An `aria-label` can hide PII from a DOM walker completely.** Several real portals label
their links, and an accessible name overrides visible text — so an element displaying an
email address was still _named_ "Customer Services", and the firewall never saw the address.
The dataset was corrected to keep label and text in step, but **the underlying exposure is
real and is not fixed**: a page whose `aria-label` disagrees with what it paints will hide
that text from the DOM walker, and only the vision pass will catch it.

**5. A 15-pixel scrollbar can destroy a benchmark.** Ground truth was first annotated in a
headless browser, where Playwright's viewport emulation hides the scrollbar; the extension
runs in a headed one, where it does not. The page laid out 15 pixels wider during annotation
than during evaluation, and on a centred layout that moved every box by eight pixels. It
scored element recall at **52%** for a system that actually scores 94%. Both now run headed
at the same viewport.

### The NER trade-off

Phase 3.2 asked for a local NER model and shipped a rule-based recogniser instead. This
dataset is the evidence for both halves of that decision. In its favour: 100% recall on
every PII type, from about 300 lines of rules, at no download and no memory. Against it: 202
false positives on real page text, all from the one part of the problem that is genuinely
linguistic. The smallest credible ONNX NER export is 94–109 MB quantised, against a 40 MB
package and a resource-utilisation line already reporting +907 MB. The seam is
`detectUnstructuredPii` — one function, drop-in — and the case for paying that cost is
stronger after this measurement than before it.

---

## Reproducing all of this

```bash
npm ci --prefix extension
pip install -r server/requirements-dev.txt
npm run build                                   # both targets, manifests validated

npm test                                        # 305 client tests, 30 server tests
cd extension
npx playwright test e2e/dataset.spec.ts         # criteria 1 and 3  -> test-results/dataset-eval.json
npx vitest  run tests/datasetPii.eval.test.ts   # criterion 2       -> test-results/dataset-pii*.json
npx playwright test e2e/profile.spec.ts         # criteria 4 and 5  -> test-results/device-profile.json
cd .. && npm run test:reasoner                  # model latency     -> test-results/reasoner-benchmark.json
```

Rebuilding the dataset itself — `node scripts/capture-dataset.mjs` then
`node scripts/annotate-dataset.mjs` — needs the internet and will produce a _different_
dataset, because the sites will have changed. The committed snapshots are the versioned
artefact; the capture script is how they were made, not something to run before measuring.
