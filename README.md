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
DOM, URLs, or any field's typed contents. See **[docs/SECURITY.md](docs/SECURITY.md)**.

## What actually works today

Stage 1 is complete. Every row below was run, not assumed.

| Capability                                                           | State                                              |
| -------------------------------------------------------------------- | -------------------------------------------------- |
| End-to-end loop: perceive → redact → reason → validate → act → audit | ✅ Working                                         |
| Credential fields excluded at extraction (never read `.value`)       | ✅ Working, regression-tested                      |
| Structured PII detection + overlap-safe tokenization                 | ✅ Working, regression-tested                      |
| Set-of-Mark context building, task-relevance filtering               | ✅ Working                                         |
| Risk gate with in-page confirmation for medium/high risk             | ✅ Working                                         |
| Audit trail in IndexedDB on the extension origin                     | ✅ Working                                         |
| `/reason` endpoint, schema-validated both directions                 | ✅ Working                                         |
| Shared wire contract generated from one source                       | ✅ Working, drift-checked in CI                    |
| Chrome + Firefox manifests                                           | ✅ Both build and validate                         |
| Verified end to end in a real browser                                | ✅ 7 Playwright tests against the loaded extension |
| Screenshot capture                                                   | ❌ Stage 2                                         |
| Local vision models (OCR / face / object)                            | ❌ Stage 2 — see below                             |
| LLM behind `/reason`                                                 | ❌ Stage 2 — a deterministic matcher stands in     |
| Benchmarks against the rubric                                        | ❌ Stage 3                                         |

**Being precise about "vision":** the perception layer today is DOM and accessibility-tree
extraction only. `visionRuntime.ts`, `ocr.ts` and `faceDetection.ts` exist and are tested,
but they are **not wired into the running pipeline** and no real model ships yet. Stage 2
adds screenshot capture and real ONNX/Tesseract inference. Until then this is a
privacy-preserving _DOM_ agent, and the README will not claim otherwise.

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
npm test          # schema drift, lint, typecheck, format, 210 client + 14 server tests
npm run build     # both browser targets + manifest validation

npm run build:chrome --prefix extension
npm run test:e2e --prefix extension   # 7 tests in a real browser, real server
```

## Repository layout

| Path                        | Contents                                                              |
| --------------------------- | --------------------------------------------------------------------- |
| `extension/src/content/`    | DOM walker, Privacy Firewall, context builder, risk gate, executor    |
| `extension/src/background/` | Orchestrator, `/reason` client, IndexedDB audit trail                 |
| `extension/e2e/`            | Playwright suite driving the loaded extension in a real browser       |
| `extension/src/schemas/`    | `generated.ts` — do not edit; regenerate with `npm run gen:schemas`   |
| `server/app/`               | FastAPI app, reasoning providers, **authoritative** Pydantic contract |
| `schemas/`                  | JSON Schema exported from the Pydantic models                         |
| `docs/`                     | Architecture, security, testing, setup                                |

## Documentation

[Security](docs/SECURITY.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Setup](docs/SETUP_GUIDE.md) · [Testing](docs/TESTING.md) ·
[Data schemas](docs/DATA_SCHEMAS.md) · [API reference](docs/API_REFERENCE.md) ·
[Build specification](PrivAgent_Build_Specification.md)

## Status and licence

Prototype for SIH evaluation — not a production deployment. Licence: TBD.
