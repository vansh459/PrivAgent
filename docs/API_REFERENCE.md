# PrivAgent API Reference

> **Status: PLANNED** — this document describes the intended design from
> `PrivAgent_Build_Specification.md`. It has not yet been verified against a working
> implementation. See the specification's Phase Gates for current build status.

Last updated: pre-implementation documentation scaffold.

No API route is implemented or callable yet. This template records the single planned reasoning route (see Build Spec Phase 5.1).

## `POST /reason`

Purpose: intended to accept a sanitized Context Builder payload and return a schema-valid Action JSON.

Request: target Screen State JSON or its finalized compact context variant. Response: target Action JSON defined in [Data schemas](./DATA_SCHEMAS.md) (see Build Spec §4.1–§4.2, Phase 5.1).

Expected behavior: valid payloads are designed to receive `200`; malformed payloads are designed to receive `422` with clear errors. Validation details, other error codes, authentication, and timeout policy are `TBD` (see Build Spec Phase 5.1–5.4).

## Future endpoints

### `TBD`

Routes added during implementation will be documented from actual FastAPI/OpenAPI definitions after Phase 5 closes.
