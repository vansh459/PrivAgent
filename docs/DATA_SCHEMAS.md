# PrivAgent Data Schemas

Schema version: **1.0**. Last verified: 2026-09-04.

Every payload below is generated from one source of truth: the Pydantic models in
`server/app/schemas.py`. Running `npm run gen:schemas` writes:

- `schemas/privagent.schema.json` — JSON Schema for all five models
- `extension/src/schemas/generated.ts` — TypeScript interfaces + Zod validators

`npm run check:schemas` fails CI if either is stale. **Do not hand-edit `generated.ts`.**

Wire fields are `snake_case`, matching Build Spec §4.1–§4.2. All models set
`extra="forbid"` / `z.strictObject`, so an unexpected field is rejected rather than
silently ignored — an accidental raw value cannot ride along inside a valid payload.

## `ScreenStateElement`

One perceived on-screen element. Client-internal.

```json
{
  "id": "dom_7",
  "role": "button",
  "text": "Download Report",
  "bbox": [820, 640, 160, 40],
  "source": "dom",
  "sensitive": false,
  "aria_label": null,
  "pii_type": null,
  "confidence": null
}
```

| Field        | Type           | Notes                                                                                               |
| ------------ | -------------- | --------------------------------------------------------------------------------------------------- |
| `id`         | string         | `dom_N` today; vision sources add their own prefixes in Stage 2.                                    |
| `role`       | string         | ARIA role if present, else derived from the tag.                                                    |
| `text`       | string         | The element's **identity** — label, `aria-label`, placeholder or name. Never a field's typed value. |
| `bbox`       | `[x, y, w, h]` | Viewport-relative CSS pixels, integers.                                                             |
| `source`     | enum           | `dom` · `vision_ocr` · `vision_face` · `vision_object`                                              |
| `sensitive`  | bool           | Set by the Privacy Firewall. `true` withholds the element from transmission.                        |
| `pii_type`   | enum?          | `AADHAAR` · `PAN` · `PHONE` · `EMAIL` · `CARD` · `OTP`                                              |
| `confidence` | float?         | 0–1. **Required** for any non-`dom` source; a model validator enforces it.                          |

## `ScreenState`

The fused local view. **Never transmitted** — it exists only inside the client.

```json
{
  "schema_version": "1.0",
  "elements": [],
  "task": "download sanctioned expenditure report",
  "page_url_hash": "sha256:…",
  "timestamp": "2026-09-04T10:00:00Z"
}
```

## `SanitizedContext` — the only payload that crosses the network

```json
{
  "schema_version": "1.0",
  "task": "download sanctioned expenditure report",
  "elements": [
    {
      "mark_id": "M1",
      "role": "link",
      "text": "Download report",
      "bbox": [820, 640, 160, 40]
    },
    {
      "mark_id": "M2",
      "role": "text_field",
      "text": "Contact [PII_PHONE_01]",
      "bbox": [400, 300, 220, 28]
    }
  ]
}
```

`mark_id` must match `^M\d+$` and is assigned contiguously in reading order over the
elements that survive filtering. Note what is _absent_: no `page_url_hash`, no `source`, no
`sensitive`, no `pii_type`, no `id`. The server gets marks it can name and nothing else.

## `Action` — server to client

```json
{
  "action": "click",
  "target_id": "M1",
  "params": {},
  "confidence": 0.96,
  "risk": "low",
  "explanation": "Matched the task to the link labelled 'Download report'.",
  "reasoning_trace_id": "trace_881"
}
```

| Field                | Type    | Notes                                                                                           |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `action`             | enum    | `click` · `type` · `scroll` · `navigate` · `none`                                               |
| `target_id`          | string? | A `mark_id`. **Required** for `click` and `type`; a validator enforces it.                      |
| `params`             | map     | `type` → `{text}`, `scroll` → `{top}`, `navigate` → `{url}`.                                    |
| `confidence`         | float   | 0–1.                                                                                            |
| `risk`               | enum    | The server's _proposal_. The client takes `max(server, local)` — it can escalate, never reduce. |
| `explanation`        | string  | Shown in the confirmation prompt via `textContent`, never `innerHTML`.                          |
| `reasoning_trace_id` | string  | For correlating with server-side logs.                                                          |

## PII token format

`[PII_<TYPE>_<NN>]`, e.g. `[PII_PHONE_01]`. Numbered in reading order, per type. Identical
values reuse one token so the server sees a consistent identity across elements.

The reverse map lives only in `ClientTokenMap`, in content-script memory. It is never
serialized, never persisted, and never transmitted. `RedactionResult` — the object that
flows onward into the pipeline, audit trail and popup — carries only type, offsets and
confidence, never the matched value.

## Audit entry

Stored in IndexedDB on the extension origin. Not part of the wire contract.

```json
{
  "seq": 3,
  "id": "0f3c…",
  "taskId": "3b7e…",
  "stage": "redact",
  "detail": "2 values tokenized; 0 elements withheld for review; 4 marks transmitted",
  "ok": true,
  "timestamp": "2026-09-04T10:00:00.123Z"
}
```

`stage` is one of `observe` · `detect_pii` · `redact` · `reason` · `validate` · `act`.
`seq` is an auto-increment key: several stages routinely land in the same millisecond, so
timestamps alone cannot order them.

`detail` carries counts and statuses only. `assertPrivacySafe()` re-runs the PII detectors
over it at write time and throws rather than persisting a match.
