# PrivAgent Changelog

Semantic versioning. The extension and server share a version number because they share a
generated wire contract — a breaking schema change breaks both.

## Unreleased

### Changed — the interface

- **One design system, defined once** in `extension/src/ui/tokens.css`: one font, two type
  sizes, an 8px spacing scale, one neutral ramp, one accent ramp and one semantic set. Both
  extension pages and the in-page confirmation prompt import that same file - the prompt
  inlines it into its closed shadow root, rewriting `:root` to `:host`, so there is no second
  copy of any value. See [DESIGN.md](./DESIGN.md) for where glass and clay are used and why.
- **Inter, vendored** (latin subset, 48 KB, SIL OFL 1.1) and pinned by SHA-256 next to the
  ONNX model. Not from a CDN, for the reason nothing else here is.
- **`tests/contrast.test.ts`** computes WCAG AA for every text/surface pair in both colour
  schemes, including the glass fill composited onto pure white and pure black - the extremes
  the in-page prompt can land on. It found five real contrast failures on its first run.
- **`e2e/screenshots.spec.ts`** captures every surface in both schemes into `docs/ui/`.

### Fixed — interface defects the redesign surfaced

- **The diagnostics page rendered at 340px.** It set `class="wide"` on a class that did not
  exist anywhere, so a full-tab options page was laid out as a popup with extension URLs
  running off the edge.
- **Its pass/fail colouring did nothing.** The class went on the value `<span>` while the
  only rule that styled it matched `li.ok .stage`, so the selector never fired.
- **Its key/value rows had no separator**, rendering as `webgpuran in 202 ms`.
- **The confirmation prompt had no dark theme.** It carried a hardcoded light-only
  stylesheet; light and dark screenshots of it were byte-identical.
- Two mojibake characters in shipped HTML and one in the OCR self-test output.

## 0.3.0 — 2026-09-06

Stage 3: the rubric numbers exist, and producing them found five real defects. Everything
below was measured before it was written down; see [`results.md`](../results.md).

### Added — evaluation

- **A versioned dataset of 42 real captured web pages** (`tests/dataset/`, v1.0): government
  portals, banks, storefronts, forms, SPAs and dashboards, frozen as inert offline snapshots
  by `scripts/capture-dataset.mjs` and labelled by `scripts/annotate-dataset.mjs` with 3 964
  ground-truth elements from Chrome's accessibility tree, 400 synthetic PII spans, 42 faces
  and 84 painted-text regions. The pages are real; the people in them are not.
- **`e2e/dataset.spec.ts`** — one pass over all 42 screens answering both the visual-context
  and redaction-precision criteria, with every outbound request blocked.
- **`e2e/profile.spec.ts`** — resource use and per-stage latency on two device tiers, the
  second emulated by confining the whole browser to two logical processors.
- **`e2e/executor.spec.ts`** — all four action types on five differently-shaped pages, with a
  per-page event ledger proving nothing else on the page was touched.
- **`e2e/demo.spec.ts`** — executes the demo script twice and records the backup video.
- **`tests/datasetPii.eval.test.ts`** and `tests/dataset/pii-review.json` — PII recall and
  precision, with a hand review of every detection outside a labelled span.
- **`results.md`**, `docs/QA_BRIEFING.md`, Mermaid architecture diagrams, and a `.xpi`
  packaged and linted by `web-ext` (0 errors).

### Fixed — detection, all found by the dataset

- **Title Case was being read as people.** The unstructured recogniser scored 100% precision
  on hand-written fixtures and fired **1 703 times** on 4 086 real strings — "Simple Tables",
  "Mailbox Pages Extras". Navigation is written in Title Case. Shape-only evidence is now
  accepted only inside short prose.
- **`main`, `near`, `layout` and `block` counted as postal addresses.** "Skip to main
  content" was masked as somebody's home, 77 times. The street-word list is now split into
  evidence and support.
- **Phone recall was 48%.** The regex demanded ten unbroken digits after an optional `+91`,
  which is how a form stores a number and not how a page shows one. `+91 98123 45670` and
  Indian landlines are now detected; recall is 100%.
- **A bare "shipping" started an address.** Every "Free shipping" badge on a storefront was
  the beginning of somebody's delivery address. The cue now requires "shipping to".
- **A no-op scroll was rejected by the client.** `params` is a string map on the wire, so
  `{top: 600}` never reached the executor — caught by the new browser suite, and exactly the
  behaviour the client-side re-validation exists for.

### Known and unfixed

- **An `aria-label` can hide PII from the DOM walker.** An accessible name overrides visible
  text, so an element painting an email address can still be _named_ "Customer Services".
  Only the vision pass catches it.
- **PII precision is 69.8%**, and 202 of the 212 false positives are the rule-based name
  recogniser. The seam for a model is one function.
- **Memory is +907 MB** over a five-page session. Three reductions are identified; none is
  done.

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
