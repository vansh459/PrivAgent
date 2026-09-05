# PrivAgent Architecture

Last verified: 2026-09-04 against the Stage 1 build. This document describes what is
**built**; anything not yet built is marked as such.

## The privacy boundary

Everything that could identify a user happens on the left of this line. Only the arrow
crosses it.

```
┌──────────────────────── BROWSER ─────────────────────────┐
│                                                           │
│  CONTENT SCRIPT (per tab, page origin)                    │
│  ┌─────────────────────────────────────────────────┐      │
│  │ perceiveDom()                                    │      │
│  │   · role, label, bbox for interactive elements    │      │
│  │   · credential fields dropped here, not later     │      │
│  │   · never reads element.value                     │      │
│  └──────────────────────┬──────────────────────────┘      │
│                          ▼                                 │
│  ┌─────────────────────────────────────────────────┐      │
│  │ prepareContext()  — the Privacy Firewall          │      │
│  │   · detect  → 6 structured PII detectors          │      │
│  │   · resolve → longest-match-wins, non-overlapping │      │
│  │   · decide  → mask ≥0.6 · review ≥0.4 · allow     │      │
│  │   · tokenize → [PII_TYPE_NN], map stays in memory │      │
│  └──────────────────────┬──────────────────────────┘      │
│                          ▼                                 │
│  ┌─────────────────────────────────────────────────┐      │
│  │ buildContext()                                    │      │
│  │   · Set-of-Mark ids (M1, M2, …)                   │      │
│  │   · withholds anything still flagged sensitive    │      │
│  │   · keeps only task-relevant elements             │      │
│  └──────────────────────┬──────────────────────────┘      │
│                          │ SanitizedContext                │
│  BACKGROUND WORKER (extension origin)                      │
│  ┌──────────────────────▼──────────────────────────┐      │
│  │ requestAction()  · re-validates before fetch      │──────┼──▶ POST /reason
│  │ audit trail      · IndexedDB, extension origin    │      │
│  └──────────────────────┬──────────────────────────┘      │◀── Action JSON
│                          │ validated Action                │
│  CONTENT SCRIPT                                            │
│  ┌──────────────────────▼──────────────────────────┐      │
│  │ effectiveRisk()  = max(server tier, local tier)   │      │
│  │ confirmAction()  · closed shadow root, if > low   │      │
│  │ executeAction()  · resolves marks → live nodes    │      │
│  └─────────────────────────────────────────────────┘      │
└───────────────────────────────────────────────────────────┘
```

## Why the background worker orchestrates

The background service worker is not a passive logger. Three independent constraints put
it at the centre:

1. **`tabs.captureVisibleTab` is only callable from an extension context.** A content
   script cannot capture the screen at all. (Stage 2.)
2. **Storage origin.** A content script's `localStorage` _and_ `indexedDB` belong to the
   _visited page's_ origin. An audit trail written there is readable by every site the
   agent visits. The background worker's storage is the extension's own.
3. **Network.** A content-script `fetch` is subject to the page's CSP; the background
   worker's uses the extension's `host_permissions`.

So: the content script perceives and acts, the background worker captures, calls the
server and stores; they communicate over `browser.runtime` messaging.

## Components as built

| Component          | File                           | State                                                                                                    |
| ------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| DOM / A11y walker  | `content/domWalker.ts`         | Built. Roles, ARIA, labels, bbox, visibility filtering, credential exclusion.                            |
| Privacy Firewall   | `content/privacy.ts`           | Built. 6 detectors, span resolution, Luhn scoring, confidence gate, token map.                           |
| Pipeline           | `content/pipeline.ts`          | Built. Applies redaction, flips `sensitive` on review, threads the mark map.                             |
| Context Builder    | `content/contextBuilder.ts`    | Built. Set-of-Mark tagging, task-relevance filter, withholds sensitive elements.                         |
| Risk gate          | `content/actions.ts`           | Built. Local tier, `max` with server tier, confirmation threshold.                                       |
| Confirmation UI    | `content/confirm.ts`           | Built. Closed shadow root, `textContent` only, Escape denies / Ctrl+Enter approves.                      |
| Action executor    | `content/actions.ts`           | Built. click / type / scroll / navigate, stale-mark detection.                                           |
| Orchestrator       | `background/service-worker.ts` | Built. Message router, task dispatch.                                                                    |
| Reasoner client    | `background/reason.ts`         | Built. Pre-flight schema check, timeout, typed errors.                                                   |
| Audit trail        | `background/audit.ts`          | Built. IndexedDB, auto-increment ordering, PII guard at write time.                                      |
| Popup              | `ui/popup.ts`                  | Built. Task entry, privacy summary, audit trace, server URL.                                             |
| Backend            | `server/app/main.py`           | Built. `/health`, `/reason`.                                                                             |
| Reasoning provider | `server/app/reasoning.py`      | **Deterministic baseline only.** No model yet — Stage 2.                                                 |
| Fusion engine      | `content/fusion.ts`            | Built and tested, **not yet wired** — nothing produces vision elements.                                  |
| Vision runtime     | `content/visionRuntime.ts`     | Backend selection only. No real model — Stage 2.                                                         |
| OCR                | `content/ocr.ts`               | Wrapper only; tests inject a fake worker. Not wired — Stage 2.                                           |
| Face detection     | `content/faceDetection.ts`     | Wraps an API absent from all target browsers; now throws instead of returning `[]`. Stage 2 replaces it. |
| Screenshot capture | —                              | **Not built.** Stage 2.                                                                                  |

## The wire contract has one source

`server/app/schemas.py` (Pydantic) is authoritative. `npm run gen:schemas` exports JSON
Schema to `schemas/privagent.schema.json` and generates
`extension/src/schemas/generated.ts` (TypeScript types + Zod validators).

CI runs `npm run check:schemas`, which fails if the checked-in output is stale — so client
and server cannot drift apart silently. Wire fields are `snake_case`, matching Build Spec
§4.1–§4.2.

Never edit `generated.ts`. Change the Pydantic model and regenerate.

## Error handling

`shared/errors.ts` defines `PrivAgentError` with a typed `code`, plus
`CapabilityUnavailableError` for missing local capabilities.

The rule: **a capability that is absent is reported as absent, never as an empty result.**
`detectFaces()` previously returned `[]` when the browser had no Shape Detection API — on
every real target browser — which reads identically to "there are no faces on screen". It
now throws.

## Entry-point naming

The two entry files are `background/service-worker.ts` and `content/content-script.ts`,
deliberately not both `index.ts`.

Two entries sharing a basename collide in the emitted chunk names, and the generated
`service-worker-loader.js` then imports the _content script's_ chunk. The background
message listener is simply never registered — with no build error, no type error and no
failing unit test. It was found only by loading the extension in a real browser, and the
e2e suite now covers it.

## Message routing

`runtime.sendMessage` broadcasts to every extension context, so the content script and the
background worker both see messages addressed to the other. Each listener returns
`undefined` for types it does not own, rather than an error reply — otherwise whichever
responds first wins the race and the intended recipient's answer is discarded.

## Cross-browser

One codebase, two manifests. `manifest.config.ts` branches on `PRIVAGENT_TARGET`, which
`vite.config.ts` sets from the build mode:

|                             | Chrome           | Firefox                |
| --------------------------- | ---------------- | ---------------------- |
| Background                  | `service_worker` | `scripts` (event page) |
| `browser_specific_settings` | omitted          | `gecko.id`, min 128.0  |
| Output                      | `dist/chrome`    | `dist/firefox`         |

`scripts/verify-manifests.mjs` asserts each target got the right shape, plus the `tabs`
permission and the `wasm-unsafe-eval` CSP that local inference needs.

Firefox note: MV3 treats `host_permissions` as opt-in, so the user must grant them from the
extension's permissions panel.
