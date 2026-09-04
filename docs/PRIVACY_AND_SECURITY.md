# PrivAgent Privacy and Security

> **Status: PLANNED** — this document describes the intended design from
> `PrivAgent_Build_Specification.md`. It has not yet been verified against a working
> implementation. See the specification's Phase Gates for current build status.

Last updated: pre-implementation documentation scaffold.

PrivAgent is designed so raw PII, raw screen imagery, client-side token mappings, and local Audit Trail data never leave the browser. Only a Privacy Firewall-sanitized, task-relevant Screen State JSON is intended to reach the backend over HTTPS (see Build Spec §2, §4).

## Intended controls

The Privacy Firewall will combine structured regex detection, local NER, face/sensitive-region masking, semantic PII tokens, and a confidence gate that flags borderline detections rather than silently passing them through (see Build Spec Phase 3). The Context Builder will filter unrelated fields and compact only the minimum required context (see Build Spec Phase 4).

## Intended fail-safe behavior

The design calls for confidence-based masking or review for uncertain sensitive data. Detailed fail-open/fail-closed behavior is `TBD` until implemented and tested; it must not be claimed as guaranteed before the Phase 3, 4, and 8 tests close (see Build Spec Phase 3.5, 4.4, 8.4).

## Regulatory consideration

The design is intended to support data-minimization and local processing principles relevant to India's DPDP Act 2023. This is a design consideration, not a legal compliance determination; legal review is `TBD` (see Build Spec §1, §2).

All guarantees in this document are unverified until Phase 3, Phase 4, and Phase 8 are completed.
