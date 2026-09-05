# PrivAgent Changelog

Semantic versioning. The extension and server share a version number because they share a
generated wire contract — a breaking schema change breaks both.

## 0.2.0 — 2026-09-04

Stage 1: the pipeline became a working loop, and two confirmed data-leak defects were
fixed. Every item below was run before being listed.

### Fixed — build

- **The service worker ran the content script's code.** Both entry files were named
  `index.ts`, so their emitted chunks collided and CRXJS's generated
  `service-worker-loader.js` imported the content script's chunk instead of the background
  one. The background message listener was therefore never registered — with no build
  error, no type error, and no failing unit test. Entries are now `service-worker.ts` and
  `content-script.ts`. Found only by running the extension in a real browser.

- **Both listeners answered messages addressed to the other.** `runtime.sendMessage`
  broadcasts to every extension context, so the content script replied "Unrecognized
  message" to the popup's request before the background worker could answer it. Each
  listener now returns `undefined` for message types it does not own.

### Fixed — security

- **Credential values were transmitted in plaintext.** `elementText()` returned
  `element.value` for any `<input>`, including `type="password"`, and DOM elements were
  hardcoded `sensitive: false`, so nothing filtered them. Verified payload before the fix:
  `{"mark_id":"M1","role":"text_field","text":"Hunter2SuperSecret",…}`.
  Credential fields are now excluded during extraction, and `.value` is never read for any
  element. Regression suite: `extension/tests/credentials.test.ts`.

- **Overlapping PII spans corrupted output and mislabelled types.**
  `ClientTokenMap.redact` applied overlapping matches via `reduceRight` with stale indices.
  `"Card 1234 5678 9012 3456 on file"` became `"Card [PII_AADHAAR_01]n file"` — a card
  labelled Aadhaar, with six characters of surrounding text destroyed. Token numbering also
  ran backwards. Spans are now resolved longest-match-first, left to right, before
  tokenizing. Regression suite: `extension/tests/privacy.test.ts`.

- **The audit trail was written to the visited page's origin.** `content/audit.ts` used
  `localStorage` from a content script, which belongs to the page — making the agent's own
  privacy log readable by every site it ran on. Moved to IndexedDB owned by the background
  service worker, on the extension origin. `assertPrivacySafe()` now re-runs the PII
  detectors over every detail string at write time and throws rather than persisting a
  match.

### Added

- **End-to-end loop.** The content script was 10 lines that walked the DOM and posted a
  count; nothing called anything else and no `fetch` existed anywhere in the extension. It
  now runs perceive → redact → build context → reason → risk gate → confirm → execute →
  audit.
- **Background orchestrator.** Message router, `/reason` client with pre-flight schema
  validation and timeouts, and audit storage.
- **Risk model.** `effectiveRisk()` takes `max(server tier, local tier)` — the server can
  escalate risk, never reduce it. Anything above `low` requires confirmation.
- **In-page confirmation prompt** in a closed shadow root, with the model's explanation set
  via `textContent`.
- **Working popup**: task entry, privacy summary (perceived / transmitted / redacted /
  withheld), live audit trace, reasoner URL. It previously printed the OS name.
- **Generated wire contract.** `server/app/schemas.py` is authoritative;
  `npm run gen:schemas` emits JSON Schema and the client's TypeScript + Zod. CI fails on
  drift.
- **Firefox support.** Per-target manifests: `background.service_worker` for Chrome,
  `background.scripts` for Firefox MV3. `scripts/verify-manifests.mjs` validates both.
- **`tabs` permission and `wasm-unsafe-eval` CSP**, prerequisites for Stage 2 capture and
  local inference.
- **CI** running schema drift, lint, typecheck, format, both test suites with a coverage
  ratchet, both builds, and manifest validation — plus a second job running the browser
  suite under `xvfb-run`.
- **Playwright e2e suite** (`extension/e2e/loop.spec.ts`): 7 tests driving the loaded
  extension and the real popup in a real browser, against a real server behind a recording
  proxy. This is what backs the privacy claims in [SECURITY.md](./SECURITY.md).
- **Keyboard handling on the confirmation prompt**: `Escape` denies, `Ctrl+Enter` approves.
  Deliberately asymmetric — dismissing should be reflexive, approving deliberate.
- Structured error types (`PrivAgentError`, `CapabilityUnavailableError`).
- Perceivability filtering: `display:none`, `visibility:hidden`, `hidden`, `aria-hidden`
  and zero-size elements are no longer reported as perceived screen content.
- Luhn scoring for card detection, used as a confidence signal rather than a filter, so
  recall on payment data is never traded for precision.
- Stable token identity: repeated values reuse one token.

### Changed

- Wire format is now `snake_case` throughout (`page_url_hash`, `mark_id`,
  `schema_version`), matching Build Spec §4.1–§4.2.
- `Action` carries the full spec shape: `risk`, `explanation`, `reasoning_trace_id`.
- `ScreenStateElement` gained `source` (`dom` · `vision_ocr` · `vision_face` ·
  `vision_object`) and `pii_type`; vision sources must carry a confidence score.
- All models reject unknown fields, so a stray raw value fails closed at both ends.
- `executeAction` returns a structured outcome instead of a boolean, distinguishing
  `stale_target`, `unsupported_target` and `missing_parameter`.
- `detectFaces()` throws `CapabilityUnavailableError` instead of returning `[]`. The Shape
  Detection API is absent from Chrome desktop stable and all Firefox, so the old empty
  array read as "no faces on screen" on every real target.
- `/health` reports the active reasoning provider.
- Audit entries use an auto-increment key; ISO timestamps cannot order stages that land in
  the same millisecond.

### Removed

- `extension/package.json`'s `"privagent": "file:.."` dependency — the extension depended
  on its own monorepo root.
- `content/audit.ts`, superseded by `background/audit.ts`.

### Known gaps

Recorded rather than implied complete:

- No screenshot capture; the vision pipeline has no input source.
- No real vision model. `visionRuntime.ts`, `ocr.ts` and `fusion.ts` are tested but not
  wired, and the only bundled ONNX asset is a 100-byte Identity graph.
- `/reason` is backed by a deterministic keyword matcher, not an LLM.
- Tesseract and ONNX Runtime still resolve assets from a CDN by default; self-hosting lands
  with the models in Stage 2.
- No benchmark dataset and no `results.md`.
- Firefox is verified only at the manifest level; Playwright cannot load extensions there.

## 0.1.0

Phases 0–1 of the Build Specification: monorepo, MV3 scaffold, strict TypeScript, FastAPI
`/health`, DOM/accessibility walker, and the first Screen State schema.
