# PrivAgent Security and Privacy Guarantees

Last verified: 2026-09-04, against the Stage 1 build (extension 0.2.0, server 0.2.0).

This document states what PrivAgent guarantees about user data, how each guarantee is
enforced in code, and which test would fail if it regressed. Claims here are limited to
what has actually been run — see [Verification status](#verification-status) for the line
between "tested" and "not yet tested".

## Threat model

| Adversary                                | What they can do                                                                       | What PrivAgent does about it                                                                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The visited website                      | Runs arbitrary JS on its own origin; reads its own `localStorage`, `indexedDB` and DOM | The audit trail is stored on the **extension** origin, not the page's. The confirmation prompt renders in a **closed** shadow root, so page script can neither read it nor synthesize a click on "Allow". |
| The reasoning server                     | Sees every payload sent to `/reason`                                                   | Only Set-of-Mark tagged, PII-tokenized, task-relevant elements are sent. No screenshots, no raw DOM, no input values, no URLs, no token map.                                                              |
| A compromised or hostile server response | Returns an arbitrary `Action`                                                          | Responses are schema-validated before use, extra fields are rejected, targets resolve through the mark map rather than coordinates, and the server **cannot lower** the locally computed risk tier.       |
| A network observer                       | Sees traffic to the reasoner                                                           | The reasoner is local-by-default (`http://127.0.0.1:8000`); nothing is sent to a third party, including model assets.                                                                                     |

## What leaves the browser

Exactly one payload crosses the network boundary: `SanitizedContext`, defined in
`server/app/schemas.py` and generated into `extension/src/schemas/generated.ts`.

```json
{
  "schema_version": "1.0",
  "task": "download the sanctioned expenditure report",
  "elements": [
    {
      "mark_id": "M1",
      "role": "link",
      "text": "Download report",
      "bbox": [820, 640, 160, 40]
    }
  ]
}
```

**Never transmitted:** screenshots or any pixel data; the raw DOM; the page URL or its
hash; any `input`, `textarea` or `contenteditable` **value**; the PII token reverse map;
the audit trail; cookies or storage.

The payload is validated against the schema in `background/reason.ts` immediately before
`fetch`, and the server rejects unknown fields (`extra="forbid"`), so an accidental extra
key fails closed at both ends rather than being transmitted and silently ignored.

## Guarantee 1 — credential values are never read

Fields whose contents are credentials or one-time secrets are dropped during
**extraction**, not during redaction. `elementText()` never reads `element.value` for any
element, so a field's contents cannot enter the pipeline even if a detector later fails to
match them.

Excluded: `input[type=password]`, `input[type=hidden]`, and any element whose
`autocomplete` is `current-password`, `new-password`, `one-time-code`, `cc-number`,
`cc-csc`, or a `cc-exp*` variant. A page can additionally opt an element out with
`data-privagent-sensitive="true"`.

Fields are described by their **identity** — label, `aria-label`, placeholder, or name —
because that is what a reasoner needs in order to act, and the typed contents are not ours
to send.

- Enforced in: `extension/src/content/domWalker.ts` (`isCredentialField`, `elementText`)
- Regression test: `extension/tests/credentials.test.ts` — 10 cases, including a full login
  form asserting the password value reaches neither the payload nor the live element refs.
- **Known trade-off:** because credential fields are excluded entirely, the agent cannot
  fill a login form. This is deliberate. Re-including them would need a design in which the
  server can address a field whose contents it is never told.

## Guarantee 2 — structured PII is tokenized, not transmitted

Detected values are replaced with stable `[PII_<TYPE>_<NN>]` tokens. The reverse map lives
only in `ClientTokenMap`, in content-script memory, and is never serialized — the
`RedactionResult` that flows onward into the pipeline, audit trail and popup deliberately
omits matched values and carries only type, offsets and confidence.

Detectors: Aadhaar, PAN, phone, email, card (Luhn-scored), OTP.

Overlapping detections are resolved **before** tokenizing — longest match wins, scanning
left to right — and equal-length ties break by detector specificity, so a card number is
never labelled as an Aadhaar number.

A Luhn-invalid card still gets masked, at lower confidence. Recall on payment data is not
traded away for precision.

- Enforced in: `extension/src/content/privacy.ts` (`resolveSpans`, `ClientTokenMap.redact`)
- Regression test: `extension/tests/privacy.test.ts` — the five adjacent/overlapping cases
  are the primary suite, each asserting exact output and correct type labelling.

> **Why these two tests exist.** Both guarantees above cover _confirmed, reproduced_
> defects in the pre-Stage-1 build, not hypothetical ones. A typed password was serialized
> into the payload verbatim, and `Card 1234 5678 9012 3456 on file` redacted to
> `Card [PII_AADHAAR_01]n file` — mislabelled, with six characters of surrounding text
> destroyed. The tests are written to fail again if either defect returns.

## Guarantee 3 — the audit trail stays inside the extension

The trail records one entry per pipeline stage (observe, detect_pii, redact, reason,
validate, act) in **IndexedDB on the extension's origin**, written only by the background
service worker.

This is why the background worker owns storage. A content script's `localStorage` _and_
its `indexedDB` both belong to the visited page's origin. Storing the trail from the
content script — in either API — would hand every visited site a readable log of what the
agent saw and redacted on it. Switching to IndexedDB alone would not have fixed that;
moving to the extension origin is what fixes it.

Entries carry counts and statuses, never observed values. `assertPrivacySafe()` re-runs the
PII detectors over every detail string at write time and **throws** rather than persisting
a match, so Build Spec Phase 7.4 is enforced at write time instead of audited afterwards.

- Enforced in: `extension/src/background/audit.ts`
- Regression test: `extension/tests/audit.test.ts`

## Guarantee 4 — the server cannot escalate its own authority

- Actions are schema-validated on arrival; a malformed action never reaches execution.
- `effectiveRisk()` takes the **stricter** of the server's proposed tier and the locally
  computed one. The server sees only redacted context, so it cannot know whether a target
  is locally sensitive; it may escalate risk, never reduce it.
- Anything above `low` risk requires explicit user confirmation before executing.
- Targets resolve through the Set-of-Mark map to live DOM nodes. A stale mark fails as
  `stale_target` rather than acting on whatever now occupies that position.
- The confirmation prompt renders into a **closed** shadow root and sets the model's
  explanation with `textContent`, never `innerHTML`. Keyboard handling is deliberately
  asymmetric: `Escape` denies, but approval requires `Ctrl+Enter` — dismissing should be
  reflexive, approving should be deliberate.

- Enforced in: `extension/src/content/actions.ts`, `confirm.ts`, `background/reason.ts`
- Regression tests: `extension/tests/actions.test.ts`, `tests/confirm.test.ts`,
  `tests/loop.test.ts`, `tests/reason.test.ts`
- Browser-verified: a server response claiming `"risk": "low"` for a `navigate` action is
  scored `high` by the client, prompts, is denied, and the navigation never happens.

## Guarantee 5 — no third-party network calls from local inference

Local inference libraries fetch their own assets from a CDN by default. In a privacy tool
that is itself a leak: it discloses to a third party that OCR is running, and when.

Verified defaults in the pinned dependencies:

- `node_modules/tesseract.js/src/worker/browser/defaultOptions.js:11` sets `workerPath` to
  `cdn.jsdelivr.net`.
- `node_modules/tesseract.js/src/worker-script/index.js:130` fetches `eng` traineddata from
  `cdn.jsdelivr.net/npm/@tesseract.js-data/...`.
- ONNX Runtime Web resolves its `.wasm` binaries from a CDN unless `ort.env.wasm.wasmPaths`
  is set.

**Status: not yet enforced.** Stage 2 vendors these assets and points every path at
`browser.runtime.getURL(...)`. Until then the OCR and ONNX code paths are not wired into
the running pipeline, so no such request is currently made — but the requirement is
recorded here because it has to land _with_ the models, not after them.

This is the one guarantee on this page that is stated as an intention rather than a fact.

The MV3 CSP is already set to `script-src 'self' 'wasm-unsafe-eval'`, which permits local
WASM instantiation while disallowing remote script.

## Verification status

| Guarantee                              | Enforced in code | Automated test                               | Verified in a real browser                |
| -------------------------------------- | ---------------- | -------------------------------------------- | ----------------------------------------- |
| 1. Credential values never read        | Yes              | Yes (`credentials.test.ts`)                  | **Yes** — captured `/reason` body         |
| 2. PII tokenized, overlaps resolved    | Yes              | Yes (`privacy.test.ts`, `piiCorpus.test.ts`) | **Yes** — captured `/reason` body         |
| 3. Audit trail on the extension origin | Yes              | Store behaviour                              | **Yes** — page storage inspected directly |
| 4. Server cannot escalate authority    | Yes              | Yes (`actions`, `loop`, `reason`, `confirm`) | **Yes** — forced high-risk action denied  |
| 5. No third-party calls from inference | No — Stage 2     | No                                           | No                                        |

Guarantees 1–4 are verified end to end in `extension/e2e/loop.spec.ts`, which loads the
real unpacked extension into a real Chromium-based browser against a real page and a real
server. Guarantee 5 remains unimplemented and is not claimed.

### What the browser run actually showed

The page under test carries a password field, a phone number, an email address, an Aadhaar
number and a card number. This is the complete `/reason` body captured on the wire for the
task _"download report"_:

```json
{
  "elements": [
    {
      "bbox": [77, 117, 170, 21],
      "mark_id": "M1",
      "role": "text_field",
      "text": "Username"
    },
    {
      "bbox": [8, 139, 109, 18],
      "mark_id": "M2",
      "role": "link",
      "text": "Download report"
    },
    {
      "bbox": [121, 138, 57, 21],
      "mark_id": "M3",
      "role": "button",
      "text": "Cancel"
    }
  ],
  "schema_version": "1.0",
  "task": "download report"
}
```

The password field is absent entirely — not redacted, never perceived. The PII-bearing
regions were perceived, redacted, and then withheld as not task-relevant, so not even
their tokens were sent. Where a PII-bearing element _is_ task-relevant it is transmitted
tokenized: for the task _"request callback"_ the payload carries
`"Request callback on [PII_PHONE_01]"`, and the number itself appears nowhere.

The visited page's own `localStorage` still contained only the key the page itself wrote,
and `indexedDB.databases()` on the page origin did not include `privagent`, while the
extension origin held the complete six-stage trail.

## Reporting

This is a Smart India Hackathon prototype, not a production deployment. Do not run it
against accounts or data you cannot afford to expose. Report issues through the
repository's issue tracker.
