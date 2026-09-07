# PrivAgent

A privacy-preserving browser agent. It perceives a web page **locally**, redacts sensitive
data **on-device**, sends only a sanitized structured context to a reasoning server, and
executes the returned action locally under a risk gate.

Built for Smart India Hackathon problem statement **26171** (ISRO) — _On-device Visual
Perception for Light-weight Browser Agents_.

```
BROWSER (content script)                    BROWSER (background worker)        SERVER
┌──────────────────────────┐                ┌────────────────────────┐    ┌─────────────┐
│ DOM / A11y walker        │                │ captureVisibleTab      │    │ FastAPI     │
│   ↓ credential fields    │                │ audit trail (IndexedDB │    │ /reason     │
│     dropped at source    │                │   on extension origin) │    │   ↓         │
│ Privacy Firewall         │  sanitized     │ fetch → /reason ───────┼───▶│ reasoning   │
│   regex + span resolve   │  context only  │                        │    │ provider    │
│   → [PII_TYPE_NN]        ├───────────────▶│                        │◀───┤ → Action    │
│ Context Builder          │                └────────────────────────┘    └─────────────┘
│   Set-of-Mark tagging    │                            │
│ Risk gate + confirmation │◀───────────────────────────┘
│ Action executor          │        validated Action
└──────────────────────────┘
```

The network boundary carries exactly one payload shape, and it never contains pixels, raw
DOM, URLs, or any field's typed contents. See **[docs/SECURITY.md](docs/SECURITY.md)**, and
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full diagram including the vision
pass, which this sketch leaves out.

## What actually works today

Stage 3 is complete. Every row below was run, not assumed, and the numbers come from
[`results.md`](./results.md) — measured over 42 real captured web pages.

| Capability                                                           | State                                                             |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| End-to-end loop: perceive → redact → reason → validate → act → audit | Working                                                           |
| Credential fields excluded at extraction (never read `.value`)       | Working, regression-tested                                        |
| Screenshot capture + local vision in an extension-origin document    | Working — YuNet face detection, Tesseract OCR, nothing from a CDN |
| Text read out of `<canvas>` and images                               | Working — **97.3%** character accuracy across the dataset         |
| Face detection and pixel redaction before OCR reads the buffer       | Working — **100%** recall, 0 faces ever transmitted               |
| Structured + unstructured PII detection, overlap-safe tokenization   | Working — **100%** recall (397/397), **93.1%** precision (hybrid rules + on-device NER verifier) |
| Redaction on the wire                                                 | **0 of 400** labelled values in any payload — structured, unstructured, faces |
| Set-of-Mark context building, task-relevance filtering               | Working — **F1 92.2%** against Chrome's accessibility tree        |
| Risk gate with in-page confirmation for medium/high risk             | Working, verified in a browser                                    |
| Action executor: click, type, scroll, navigate                       | Working — all four types on five pages, no misfires               |
| Audit trail in IndexedDB on the extension origin                     | Working                                                           |
| `/reason` endpoint, schema-validated in both directions              | Working                                                           |
| Real open-weight LLM behind `/reason`                                | Working — Qwen2.5-1.5B on local Ollama, opt-in                    |
| Chrome + Firefox builds                                              | Both build and validate; `.xpi` lints clean                       |
| Benchmarks against all five rubric criteria                          | Measured — see [`results.md`](./results.md)                       |
| Firefox load on a clean profile                                      | **Verified live** (2026-09-06) — Firefox 155.0.1, both pipelines, 0 raw PII on the wire (`scripts/verify-firefox.py`) |
| Multi-step agentic loop (additive)                                   | **Working** — 15/15 unit tests, e2e 3/3 in one run (9/9 across repeats): navigation-crossing done, bot-wall stop, cancel; live-site validation still open |
| Human demo rehearsal and Q&A rehearsal                               | **Not done** — the scripts exist, nobody has read them aloud      |

**Being precise about "vision":** perception now really is visual. The pipeline takes a
screenshot in the background worker, decodes it in an extension-origin offscreen document,
runs a 232 KB YuNet detector over the whole viewport, paints every detected face out of the
buffer, and only then lets OCR read from it. Everything it reads goes through the same
Privacy Firewall as DOM text, because it is fused in _before_ redaction rather than after.

**Being precise about what is weak.** Memory remains the worst number, now honestly
attributed (re-measured 2026-09-07): a no-extension control run costs **+49 MB** over the
same five pages, the pipeline's in-task peak is **+1,047 MB** on tier 1 — a transient
working figure of a 20-task back-to-back workload — and what a session actually *retains*
after 95 s of idle is **+192 MB** (tier 2: +823 peak / +347 settled). PII precision was
69.8%; the on-device NER verifier (2026-09-06) raised it to **93.1%** with recall intact
(397/397) and element F1 unregressed at 92.7% — 36 false positives remain. And with the
local model in the loop a task still takes about ten seconds instead of one. All of it is
measured and explained in [`GAP_ANALYSIS.md`](./GAP_ANALYSIS.md); [`results.md`](./results.md)
still carries some pre-fix figures pending the final measurement pass.

## Quick start

Requires Node 20+ and Python 3.12+.

```bash
# 1. Install
npm ci --prefix extension
pip install -r server/requirements-dev.txt

# 2. Start the reasoner (leave running)
npm run dev            # or: python -m uvicorn app.main:app --app-dir server --port 8000

# 3. Build the extension
npm run build:chrome --prefix extension     # → extension/dist/chrome
npm run build:firefox --prefix extension    # → extension/dist/firefox
```

Load `extension/dist/chrome` at `chrome://extensions` (Developer mode → Load unpacked), or
`extension/dist/firefox` at `about:debugging` → This Firefox → Load Temporary Add-on.

Open the toolbar popup, type a task such as `download report`, and press **Run task**. The
popup shows how many elements were perceived, how many were redacted, how many marks were
transmitted, and the full audit trail.

Full instructions: **[docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md)**.

## Verify

```bash
npm test                    # schema drift, lint, typecheck, format, 305 client + 30 server tests
npm run build               # both browser targets + manifest validation
npm run test:e2e --prefix extension   # 24 tests in a real browser against the loaded extension
```

Reproduce the rubric numbers (each writes its JSON into `test-results/`):

```bash
npm run eval:dataset        # visual-context accuracy and redaction precision, 42 screens
npm run eval:profile        # resource use and end-to-end latency, two device tiers
npm run demo:rehearse       # runs the demo script twice and re-records the backup video
npm run test:reasoner       # the real local model; needs Ollama with qwen2.5:1.5b
npm run package:firefox     # web-ext lint + a signed-shape .xpi in extension/dist/
```

## Repository layout

| Path                            | Contents                                                              |
| ------------------------------- | --------------------------------------------------------------------- |
| `extension/src/content/`        | DOM walker, Privacy Firewall, context builder, risk gate, executor    |
| `extension/src/background/`     | Orchestrator, `/reason` client, IndexedDB audit trail                 |
| `extension/e2e/`                | Playwright suite driving the loaded extension in a real browser       |
| `extension/src/schemas/`        | `generated.ts` — do not edit; regenerate with `npm run gen:schemas`   |
| `server/app/`                   | FastAPI app, reasoning providers, **authoritative** Pydantic contract |
| `schemas/`                      | JSON Schema exported from the Pydantic models                         |
| `extension/e2e/dataset.spec.ts` | The Phase 8 evaluation harness: 42 screens, one pass, two criteria    |
| `tests/dataset/`                | The versioned evaluation dataset — 42 captured pages, ground truth    |
| `scripts/`                      | Dataset capture and annotation, schema generation, manifest checks    |
| `docs/`                         | Architecture, security, testing, setup, demo script, Q&A briefing     |
| `results.md`                    | Every rubric number, with the command that produced it                |

## Documentation

**[Results](results.md)** — every rubric number and what is wrong with it ·
[Design system](docs/DESIGN.md) ·
[Dataset](tests/dataset/README.md) · [Security](docs/SECURITY.md) ·
[Architecture](docs/ARCHITECTURE.md) · [Setup](docs/SETUP_GUIDE.md) ·
[Testing](docs/TESTING.md) · [Benchmarks](docs/BENCHMARKS.md) ·
[Demo script](docs/DEMO_SCRIPT.md) · [Q&A briefing](docs/QA_BRIEFING.md) ·
[Data schemas](docs/DATA_SCHEMAS.md) · [API reference](docs/API_REFERENCE.md) ·
[Build specification](PrivAgent_Build_Specification.md)

## Status and licence

Prototype for SIH evaluation — not a production deployment. Licence: TBD.
