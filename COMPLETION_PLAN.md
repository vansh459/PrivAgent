# Completion Plan — PrivAgent → full PS 26171 compliance + universal agentic browsing

Companion to [`GAP_ANALYSIS.md`](./GAP_ANALYSIS.md), same audit date (2026-09-06). Tasks are
ordered by **rubric weight first, dependency second**: the two 20% PII/redaction lines carry
the largest measured gaps, so they come before everything else; resource and latency (20% +
15%) follow; the universal agentic loop is additive and comes only after the PS-required
pipeline is at its best.

Every task states what "done" means as something a command can verify — not "improve X".

---

## The ordered list

### 1. Hybrid NER verifier for NAME/ADDRESS precision — rubric 2 (20%) — effort L — no dependencies — ✅ DONE 2026-09-06

**Outcome:** precision **69.6% → 93.1%**, recall still **397/397**, F1 on the browser
dataset run 92.6% (no regression), 0 new leaks. Evaluated TinyBERT-int8 (14.5 MB) vs
DistilBERT-int8 (65.8 MB) offline (`scripts/eval-ner-verifier.py` →
`test-results/ner-verifier-eval.json`); shipped TinyBERT at threshold 0.02 — rejects
128/133 reviewed FPs, keeps 31/31 real names and 42/42 labelled names, ~1 ms/candidate.
Implementation: `extension/src/content/nameVerifier.ts` (WordPiece tokenizer + scorer),
hosted in the extension-origin vision document (`src/vision/verifyNames.ts`, routed like
`analyzeInHost`), applied in `prepareContext` before span resolution, fail-closed.
Memory cost of the model asset: 14.5 MB on disk; runtime delta measured in task 3's
profile run.

The single largest measured gap: precision 69.6%, with 202 of 212 false positives being the
rule-based NAME recogniser firing on Title-Case UI text ("Appeal No", "Fixed Deposit").

- Keep the rules as the candidate generator (they hold recall at 100%).
- Add a small quantized ONNX token-classification model that runs **only over rule
  candidates** (dozens of short strings per page, not the whole DOM), lazily loaded through
  the existing `createVisionSession` runtime and vendored like every other model
  (`scripts/vendor-assets.mjs`); evaluate ≥2 candidate models offline for size vs. verdict
  quality before wiring one in.
- Seam: `detectUnstructuredPii` (`extension/src/content/unstructuredPii.ts:355`) — the
  module's own header names this as the replacement point.

**Done =** `npx vitest run tests/datasetPii.eval.test.ts` reports precision ≥ 90% with
recall still 397/397; the model's memory cost measured in isolation and reported in
`results.md`; no third-party fetches (asset vendored).

### 2. Zero unstructured redaction leaks — rubric 3 (20%) — effort M — ✅ DONE 2026-09-06

**Outcome:** `e2e/dataset.spec.ts` wire capture: **0/400** values in any payload
(unstructured 3 → 0), F1 92.7% (no regression), precision still 93.1%, recall 397/397.
The prose-gate hypothesis was wrong — reproducing each leak string through the redactor
found two real bugs instead: `trimToName` dropped candidates containing newlines (offset
lookup on a space-rejoined string), and `resolveSpans` dropped a whole ADDRESS span when
a structured span had consumed its head. Fixes: per-line unstructured detection
(`detectUnstructuredPii` splits on `\n` with offset mapping), offset-correct
`trimToName`, and partial-span trimming in `resolveSpans` for NAME/ADDRESS.

> **Progress note (2026-09-07):** task 3 partially landed — OCR worker idle release
> (`scheduleOcrIdleRelease`, 90 s, `src/vision/analyze.ts`, unit-tested) and the
> no-extension control tier + settled-memory sample in `e2e/profile.spec.ts`. First
> control-run numbers: control **+76 MB** vs tier1 **+1,128 MB** / tier2 **+963 MB** —
> the pipeline owns most of its delta and now says so with a measurement; the settled
> sample shows tier1 retains only **+192 MB** after 95 s idle (OCR release working). The
> C2b Foundry provider also landed early (`server/app/foundry.py`, 8 offline tests,
> env-only config, `.env.example`, SECURITY.md disclosure) since it shares no code with
> the loop work. **C1 schema v1.1 landed 2026-09-07**: ActionType += done/blocked
> (blocked requires params.reason ∈ bot_detection|login_required|cannot_proceed),
> SanitizedContext += optional step {n,limit} + history (redacted page_ident, never a
> URL; unknown fields rejected), SYSTEM_PROMPT v2.0 (rules 9-10, rule 5 kept),
> render_context renders step/history, DeterministicProvider answers done-on-history,
> executor treats done/blocked as terminal no-ops. 1.0 payloads stay valid. 355 client +
> 45 server tests green; both targets build.

### 3. Memory reductions — rubric 4 (20%) — effort M — no dependencies (parallel with 1–2) — ✅ DONE 2026-09-07 (attributed; rubric verdict stays Partial)

**Outcome:** OCR worker idle release shipped (self-terminates after 90 s idle,
`src/vision/analyze.ts scheduleOcrIdleRelease`, unit-tested); no-extension control tier and
settled-after-idle sampling added to `e2e/profile.spec.ts`. Final re-run (2026-09-07):
control **+49 MB** vs tier 1 peak **+1,047 MB / settled +192 MB**, tier 2 **+823 / +347** —
the peak is a transient working figure of a 20-task workload, the retained footprint is
~0.2–0.35 GB, and both are reported as themselves. The WASM-only ORT swap was **deliberately
declined** (it would forfeit the PS-named WebGPU path); the pre-scaled detector input stays
open (the buffer is ~4 MB — not where the memory is). Documented as Partial in
`GAP_ANALYSIS.md`, honestly attributed.

The three reductions already identified but never done, plus honest attribution:

- Ship the WASM-only ONNX Runtime build in the vision host (the combined WebGPU+WASM bundle
  costs ~27 MB and WebGPU is SwiftShader-only on this class of machine anyway).
- Hand YuNet a pre-scaled 640×640 buffer instead of the full-viewport bitmap.
- Release the OCR worker after an idle period.
- Add a control run (same 5 pages, extension disabled) to `e2e/profile.spec.ts` so the
  headline number separates "five pages of modern web" from "the pipeline".

**Done =** re-measured `npx playwright test e2e/profile.spec.ts` shows a materially lower
attributable-MB figure plus a baseline-vs-extension attribution table in
`test-results/device-profile.json`; face recall on `dataset.spec.ts` does not regress from
the input rescale.

### 4. Latency — rubric 5 (15%) — effort M — depends on 3 (measure once, after)

- Model choice by measurement: run `scripts/compare-reasoners.py` over qwen2.5:1.5b,
  llama3.2:1b (both installed) and qwen2.5:0.5b (pull) at prompt v1.x; pick the best
  accuracy/latency point; set Ollama `keep_alive` so the model stays warm between steps.
- Profile and cut the "rest" segment (DOM walk → firewall → context build), which now
  exceeds the vision pass on element-heavy portals.

**Done =** fresh `test-results/reasoner-benchmark.json` + `device-profile.json` medians;
the chosen model documented with its measured accuracy; warm-task median with the
deterministic provider at or under the current ~1 s despite tasks 1–2 adding a verifier.

### 5. Real Firefox verification — PS deliverable — effort M — depends on 1–3 (verify the final pipeline, not the old one) — ✅ DONE 2026-09-06

**Outcome:** real Firefox 155.0.1, `dist/firefox` as a temporary add-on, both pipelines
(DOM + event-page vision) executed with wire capture: 2 requests, **0 raw planted PII**
values on the wire (`test-results/firefox-verification.json`, `"verdict": "PASS"`;
reproducible via `python scripts/verify-firefox.py`). Caveat: fixture pages; the new
multi-step loop path has **not** yet been re-verified in Firefox (event page, no 30 s cap —
expected to behave better than Chrome's worker, but unverified).

`winget install Mozilla.Firefox`; load `extension/dist/firefox` via `about:debugging`; run
real tasks on real pages; exercise the event-page vision path
(`background/vision.ts:119` branch); fix whatever breaks (candidates: WASM threading flags,
capture quota behaviour, polyfill edges).

**Done =** the full pipeline (perceive → vision → redact → reason → confirm → act → audit)
executes in a real Firefox on a clean profile, with the audit trail and a wire-captured
payload as evidence, recorded in `GAP_ANALYSIS.md` and `README.md`.

### 6. Schema v1.1: multi-step vocabulary — universal loop foundation — effort M — no rubric line (additive) — no dependencies — ✅ DONE 2026-09-07

**Outcome:** landed as described in the progress note under task 2 — ActionType +=
`done`/`blocked` (blocked requires a reason), SanitizedContext += optional `step` +
`history` with **redacted** `page_ident` (never a URL; unknown history fields rejected as a
leak guard), SYSTEM_PROMPT v2.0, deterministic done-on-history, 1.0 payloads still valid.
Covered by `server/tests/test_schema_v11.py` (7 tests) plus regenerated client zod/TS.

Single source of truth is `server/app/schemas.py` → `npm run gen:schemas`.

- `ActionType` += `done` (params carry a one-line result summary) and `blocked`
  (`params.reason` ∈ `bot_detection | login_required | cannot_proceed`).
- `SanitizedContext` += optional `step: {n, limit}` and `history[]` of compact prior-step
  records `{action, target_role, outcome, page_ident}` — `page_ident` is the page **title
  passed through the Privacy Firewall**, never a URL (preserves the SECURITY.md "no URLs"
  boundary).
- Propagate: regenerate zod/TS; update `prompt.py` (render history; SYSTEM_PROMPT v2 with
  multi-step rules — completion criterion, "answer done when the task is already
  satisfied"), `reasoning.py` (deterministic provider answers `done` when history shows a
  satisfying step — keeps CI meaningful), `ollama.py` semantic checks, server + client
  tests.

**Done =** `npm run check:schemas` clean; `npm test` green including new cases for
`done`/`blocked` round-trips; old single-step payloads (no `step`/`history`) still accepted.

### 7. Background task loop controller — universal loop core — effort L — depends on 6 — ✅ DONE 2026-09-07 (e2e verified)

**Status:** `extension/src/background/taskLoop.ts` landed — step budget 15, settle-retry
across navigations, cancellation, stall detection, every terminal state
(`done`/`blocked`/`declined`/`cancelled`/`no_progress`/`failed`/`budget_exhausted`).
Unit tests **15/15 green** (`tests/taskLoop.test.ts`, scripted-transport seams plus
mocked-polyfill default-transport tests). Two navigation-race fixes landed the same day:
the popup no longer awaits one long run-loop message (Chrome closes that channel
mid-loop) — it polls a stored `loop-result`; and the content script fires an out-of-band
`step-result` copy before its first post-execution await, so a navigating click cannot
lose its own report. After those fixes the `e2e/agentLoop.spec.ts` suite
(navigation-crossing done, bot-wall stop, stop button) passed **3/3 in a single run
(13.8 s) and 9/9 under `--repeat-each=3`** against the rebuilt bundle — the previous
order-dependent flake is gone.

New `extension/src/background/taskLoop.ts`; the loop lives in the background because a
navigating action destroys the content script.

- State machine per step: perceive (message content script) → reason → risk gate/confirm
  (in-page) → execute → settle → next, terminating on `done`, `blocked`, decline (graceful
  `declined`, not an error), step budget (~15), cancellation, or error.
- Navigation survival: after `navigate`/navigating click, await `tabs.onUpdated` complete
  on the target tab, then re-message the auto-injected content script; bounded wait.
- Content script: split `runTask` into per-step `perceive+prepare` and `execute` halves;
  the existing single-shot path stays intact for the popup and all current tests.
- MV3 keep-alive: verify the service worker survives a multi-minute loop (alarm or port
  anchor if needed); Firefox event pages have no 30 s cap.

**Done =** unit tests drive the state machine with injected fake steps through every
terminal state; new `e2e/agentLoop.spec.ts` completes a ≥3-step task across a multi-page
fixture in a real browser with every wire payload schema-valid.

### 8. Azure Foundry Claude provider — universal-loop brain — effort M — depends on 6 (schema), parallel with 7 — ✅ DONE 2026-09-07

**Outcome:** `server/app/foundry.py` landed with forced tool-use structured output and the
same hallucinated-target validation as Ollama; 8 offline tests
(`server/tests/test_foundry.py`, scripted transport); key in untracked `server/.env`
(verified gitignored) + `.env.example`; `docs/SECURITY.md` disclosure added. **Live-verified**
through the real deployment: "download the report" → `click` conf 0.95 in ~5.7 s; "delete my
account" → `none` (correct refusal). Fallback chain shipped too: `/health` reports
`foundry:claude-fable-5 -> ollama:qwen2.5:1.5b -> deterministic`, falling through only on
transport failure, never on an answered `none`. Ollama remains the provider for **all**
rubric measurements and the judged demo, per the PS boundary below.

Third provider behind the `ReasonProvider` seam: `server/app/foundry.py`, selected by
`PRIVAGENT_REASONER=foundry`, env-configured (`PRIVAGENT_FOUNDRY_BASE_URL`, `_API_KEY`,
`_MODEL` default `claude-fable-5`), Anthropic Messages API with structured output, the same
hallucinated-mark validation as `ollama.py`. Key lives in an untracked `.env`
(+ `.env.example`); never committed.

**PS boundary, stated everywhere it matters:** the PS requires an offline open-source LLM —
Ollama/Qwen remains the provider for every rubric measurement and the judged demo. Foundry
Claude is the clearly-labeled optional brain for the additive universal-browsing demo
(~1–2 s/step vs 10–14 s local). Privacy boundary unchanged (sanitized tokens only), and
`docs/SECURITY.md` gains an honest paragraph about the third-party hop when this provider
is selected.

**Done =** server tests cover the provider with a scripted transport; a live smoke test
answers a real context; `/health` reports `foundry:claude-fable-5`; secrets absent from git.

### 9. Bot-block detection: detect and stop, never evade — effort M — depends on 7 — ✅ DONE 2026-09-07

**Outcome:** `extension/src/content/botBlock.ts` landed, gating every step **before** a
single element is read: reCAPTCHA/hCaptcha/Turnstile widgets and iframes,
Cloudflare/Akamai/PerimeterX challenge markers, interstitial titles (gated by a
page-shape check so an article *about* CAPTCHAs is not a false stop). **10 unit tests**
(`tests/botBlock.test.ts`) including negatives; the bot-wall e2e test has passed (loop
stops at step one, 0 `/reason` requests, URL unchanged, the tempting "Continue" link never
clicked). No evasion of any kind, by policy.

New `extension/src/content/botBlock.ts`, checked at each perceive step: reCAPTCHA/hCaptcha/
Turnstile widgets and iframes, Cloudflare/Akamai challenge-page markers, "verify you are
human"/"unusual traffic" interstitials. On detection the loop ends with
`blocked: bot_detection` and the user sees "This site blocks automation — stopping." No
evasion of any kind, by policy.

**Done =** unit tests against fixture HTML for each challenge family; an e2e fixture run
ends the loop cleanly with the blocked status surfaced in popup + audit trail.

### 10. Popup progress + cancel — effort M — depends on 7 — ✅ DONE 2026-09-07 (stop-button e2e green 3/3)

**Outcome:** multi-step checkbox, live per-step progress (800 ms audit-trail poll by
taskId), Stop button (`privagent/cancel-task`; the loop checks the flag between steps), and
completion via polled `loop-result` rather than one long message await. The stop-button e2e
test is part of the `agentLoop.spec.ts` re-run noted under task 7.

Live per-step progress in the popup (render the audit trail by taskId as it grows) and a
Stop button (`privagent/cancel-task` → the loop checks a flag between steps). The loop
continues if the popup closes; a reopened popup re-attaches to the latest running task.

**Done =** e2e: start a multi-step task, close/reopen the popup mid-run, watch progress
resume, cancel, see status `cancelled` in ≤1 step.

### 11. Live-site validation of the universal loop — effort M — depends on 7–10

Run the loop on ~5 visibly different real sites (research task on Wikipedia, a public form,
an e-commerce comparison, a government-portal lookup, and one site known to challenge
automation to prove the clean stop), with Foundry Claude as the brain and one comparison
run on Ollama. Record steps, outcomes and wire captures.

**Done =** a written run log with per-site step counts and outcomes; every captured payload
schema-valid and token-redacted; the bot-blocking site ends in `blocked`, not a crash or an
evasion.

### 12. Final measurement pass + docs — effort M — depends on all above

Re-run the complete matrix (`npm test`, both builds, dataset, PII eval, profile, reasoner
benchmark, demo rehearsal) on the final build; update `results.md`, `README.md`,
`docs/ARCHITECTURE.md` + `docs/SECURITY.md` (loop + schema v1.1 + foundry provider),
`docs/DEMO_SCRIPT.md`; refresh `GAP_ANALYSIS.md` verdicts to final state.

**Done =** every rubric line carries a number produced by the final build; no doc claims
anything the audit date's runs did not show.

---

## Rubric coverage of the list

| Task | Moves | Weight touched |
| --- | --- | --- |
| 1 NER verifier | Rubric 2 precision 69.6% → ≥90% | 20% |
| 2 Leak fix | Rubric 3 leaks 3 → 0 | 20% |
| 3 Memory | Rubric 4 attributable MB ↓ + honest attribution | 20% |
| 4 Latency | Rubric 5 model + "rest" segment | 15% |
| 5 Firefox | PS deliverable (both browsers) | gate |
| 6–11 Universal loop | Differentiator (additive) | — |
| 12 Final pass | Every number re-run | all |

Deliberately **not** planned: replacing YuNet/Tesseract with an actual ViT (cost on rubric 4
outweighs any rubric-1 gain from an already-92% F1 baseline); fixing the
`aria-label`-vs-painted-text exposure (real, documented, but requires OCR-vs-accessible-name
cross-checking whose false-positive cost is unbounded — documented as a known limitation
instead); evading bot detection (out of scope by policy, not by difficulty).
