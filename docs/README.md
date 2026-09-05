# PrivAgent Documentation

Last updated: 2026-09-04 · Stage 1 complete · extension 0.2.0, server 0.2.0

Start at the [root README](../README.md) for what the project is and how to run it. This
page is the map of the documentation and the honest status of each build phase.

## Documentation map

| Document                                                   | What it holds                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [SECURITY.md](./SECURITY.md)                               | Threat model, the five guarantees, what enforces each, and what is _not_ yet verified. **Read this first.** |
| [ARCHITECTURE.md](./ARCHITECTURE.md)                       | The privacy boundary, why the background worker orchestrates, per-component build state.                    |
| [SETUP_GUIDE.md](./SETUP_GUIDE.md)                         | Install and run, with real recorded output.                                                                 |
| [TESTING.md](./TESTING.md)                                 | Every suite, real counts, coverage gates, and known-weak tests.                                             |
| [DATA_SCHEMAS.md](./DATA_SCHEMAS.md)                       | The generated wire contract.                                                                                |
| [API_REFERENCE.md](./API_REFERENCE.md)                     | `/health` and `/reason`, with real requests and responses.                                                  |
| [BENCHMARKS.md](./BENCHMARKS.md)                           | Rubric measurements. Stage 3 — currently unmeasured.                                                        |
| [USER_GUIDE.md](./USER_GUIDE.md)                           | Using the extension.                                                                                        |
| [DEMO_SCRIPT.md](./DEMO_SCRIPT.md)                         | Demo walkthrough.                                                                                           |
| [TROUBLESHOOTING_FAQ.md](./TROUBLESHOOTING_FAQ.md)         | Problems encountered and their fixes.                                                                       |
| [CHANGELOG.md](./CHANGELOG.md)                             | Real shipped changes.                                                                                       |
| [CONTRIBUTING.md](./CONTRIBUTING.md)                       | Branching, phase-gate discipline, PR expectations.                                                          |
| [Build Specification](../PrivAgent_Build_Specification.md) | The original phased plan and its notes.                                                                     |

## Build status

Against the [Build Specification](../PrivAgent_Build_Specification.md) phases.

| Phase | Scope                          | State                                                                                                                                                                        |
| ----- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Setup and environment          | ✅ Complete                                                                                                                                                                  |
| 1     | DOM / accessibility extraction | ✅ Complete                                                                                                                                                                  |
| 2     | Local vision perception        | ⚠️ **Scaffolding only** — runtime selection, an OCR wrapper and a fusion engine exist and are tested, but no model ships, nothing is wired, and there is no screenshot input |
| 3     | Privacy Firewall               | ⚠️ **Structured PII complete**; credential exclusion, span resolution, tokenization and the confidence gate all working and regression-tested. No NER, no pixel redaction    |
| 4     | Structured Context Builder     | ✅ Complete — Set-of-Mark tagging, relevance filtering, strict serialization                                                                                                 |
| 5     | Backend reasoning              | ⚠️ **Endpoint complete, model absent** — `/reason` validates both directions; a deterministic matcher stands in for an LLM                                                   |
| 6     | Validation and execution       | ✅ Complete — risk tiers, confirmation gate (browser-verified), all four action types, stale-mark handling                                                                   |
| 7     | Explainability and audit trail | ✅ Complete — six stages in IndexedDB on the extension origin, rendered in the popup, origin isolation proven in a browser                                                   |
| 8     | Testing and benchmarks         | ⚠️ **Tests yes, benchmarks no** — 210 client + 14 server + 7 browser tests pass; no dataset and no `results.md`                                                              |
| 9     | Packaging and demo             | ⚠️ Both builds produce validated manifests and the Chrome build loads and runs in a browser; no `.xpi`, no Firefox load, no rehearsed demo                                   |

## What is deliberately not claimed

The largest rubric line — accuracy of _visual_ context, 25% — is not yet addressed. The
perception layer today is DOM and accessibility-tree extraction. That is genuinely useful
and it is what the working loop runs on, but it is not visual perception, and no document
in this repository should be read as saying otherwise until Stage 2 lands screenshot
capture and real on-device models.

In-browser behaviour _is_ now verified: seven Playwright tests drive the loaded extension
against a real page and a real server, and they are what backs the privacy claims — see
[TESTING.md](./TESTING.md#browser-end-to-end) and
[SECURITY.md](./SECURITY.md#verification-status). Firefox is the exception: only its
manifest shape is checked, because Playwright cannot load extensions in Firefox.

## Phase-gate discipline

A checked box means built **and** tested, never attempted. Where something is built but its
acceptance test has not been run, it stays unchecked with the blocker recorded — see the
Notes in the Build Specification. Documentation is updated in the same change as the code
it describes.

## Licence and credits

Licence: TBD. Team and contributor credits: TBD.
