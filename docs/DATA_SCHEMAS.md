# PrivAgent Data Schemas

> **Status: PLANNED** — this document describes the intended design from
> `PrivAgent_Build_Specification.md`. It has not yet been verified against a working
> implementation. See the specification's Phase Gates for current build status.

Last updated: pre-implementation documentation scaffold.

Schema version: `TBD`. These are target contracts, copied from Build Spec §4.1 and §4.2; illustrative values are not captured runtime payloads.

## Target Screen State JSON

```json
{
  "elements": [{"id":"el_07","role":"button","text":"Download Report","bbox":[820,640,160,40],"source":"dom","sensitive":false},{"id":"el_12","role":"text_field","text":"[PII_PHONE_01]","bbox":[400,300,220,28],"source":"vision_ocr","sensitive":true,"pii_type":"phone"}],
  "task":"download sanctioned expenditure report",
  "page_url_hash":"sha256:...",
  "timestamp":"2026-09-04T10:00:00Z"
}
```

Each element is intended to carry an ID, role, text, bounding box, source, and sensitivity state. The finalized validation schema is `TBD` (see Build Spec §4.1, Phase 1.3).

## Target Action JSON

```json
{"action":"click","target_id":"el_07","params":{},"confidence":0.96,"risk":"low","reasoning_trace_id":"trace_881"}
```

This is the planned server-to-client action contract, not a successful response example (see Build Spec §4.2).

## Planned PII token format

`[PII_<TYPE>_<N>]`, such as `[PII_PHONE_01]`. A stable reverse map is intended to remain in client memory only (see Build Spec Phase 3.4).

## Planned audit entry schema

`TBD`. The Audit Trail is intended to have at least Observe, Detect PII, Redact, Reason, Validate, and Act stage entries, with no raw PII (see Build Spec Phase 7.1, 7.4). Real sanitized examples will replace these illustrative schemas after Phase 4 and Phase 7 validation.
