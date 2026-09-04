# PrivAgent Documentation

> **Status: PLANNED** — this document describes the intended design from
> `PrivAgent_Build_Specification.md`. It has not yet been verified against a working
> implementation. See the specification's Phase Gates for current build status.

Last updated: Phase 0 complete; Phase 1 not started.

PrivAgent is planned as a privacy-preserving browser agent: it will perceive a page locally, redact sensitive information on-device, send only a sanitized Screen State JSON to a server-side reasoner, and validate then execute a returned action locally (see Build Spec §1, §4).

## Planned capabilities

- Local DOM/accessibility extraction plus visual perception for canvas, video, images, and iframes (see Build Spec §2, Phases 1–2).
- A client-side Privacy Firewall for structured and unstructured PII, faces, masking, and tokenization (see Build Spec §2, Phase 3).
- Compact, task-relevant Context Builder payloads and structured server actions (see Build Spec §4, Phases 4–5).
- Local risk gating, Action Executor, and privacy-safe Audit Trail (see Build Spec §2, Phases 6–7).

## Intended architecture

```text
┌───────────────────────────────── BROWSER (CLIENT) ─────────────────────────────────┐
│ Content Script → DOM / A11y Walker ─┐                                                │
│ Screenshot Capture → Local Vision ──┼─→ Fusion Engine → Privacy Firewall             │
│                                     │                  → Context Builder             │
└─────────────────────────────────────┼────────────────────────────────────────────────┘
                                      │ HTTPS (sanitized payload only)
┌───────────────────────────────── SERVER (BACKEND) ──────────────────────────────────┐
│ FastAPI /reason → LLM / VLM Reasoner → Structured Action JSON                        │
└──────────────────────────────────────────────┼──────────────────────────────────────┘
                                               │ HTTPS response
┌───────────────────────────────── BROWSER (CLIENT) ─────────────────────────────────┐
│ Risk & Confidence Validator → Action Executor → Audit Trail Logger                   │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

See [Architecture](./ARCHITECTURE.md) for the full intended component diagram.

## Planned quick start

Once Phase 0 is complete, setup is intended to involve cloning the repository, installing the extension and server dependencies, starting the FastAPI service, building the extension, and loading its unpacked build in Chrome or Firefox. Exact commands, supported versions, and browser-loading instructions are `TBD` until the implementation exists (see Build Spec Phase 0; [Setup guide](./SETUP_GUIDE.md)).

## Build status

| Phase | Intended scope | State |
|---|---|---|
| 0 | Setup and environment | ☑ Complete |
| 1 | DOM / accessibility extraction | ☐ Not started |
| 2 | Local vision perception | ☐ Not started |
| 3 | Privacy Firewall | ☐ Not started |
| 4 | Structured Context Builder | ☐ Not started |
| 5 | Backend reasoning | ☐ Not started |
| 6 | Validation and execution | ☐ Not started |
| 7 | Explainability and Audit Trail | ☐ Not started |
| 8 | Testing and benchmarks | ☐ Not started |
| 9 | Packaging and demo preparation | ☐ Not started |

States reflect the Build Specification Phase Gates. Phase 0 is verified only to its recorded Chrome-only and local-only scope; later phases remain planned.

## Documentation map

[Architecture](./ARCHITECTURE.md) · [Technology stack](./TECH_STACK.md) · [Data schemas](./DATA_SCHEMAS.md) · [API reference](./API_REFERENCE.md) · [Testing](./TESTING.md) · [Privacy and security](./PRIVACY_AND_SECURITY.md)

## License and credits

License: `TBD`. Team and contributor credits: `TBD`.
