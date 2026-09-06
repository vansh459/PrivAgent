# Contributing to PrivAgent

Last updated: 2026-09-04.

## Before you push

```bash
npm test                              # what the main CI job runs
npm run build                         # both targets + manifest validation
npm run test:e2e --prefix extension   # the browser suite (needs a Chrome build first)
```

CI runs the first two in one job and the browser suite in a second, so a
browser-environment failure cannot be mistaken for a code failure.

## The wire contract is generated

`server/app/schemas.py` is the single source of truth. After changing it:

```bash
npm run gen:schemas   # regenerates schemas/*.json and extension/src/schemas/generated.ts
```

Commit both generated files. `npm run check:schemas` fails CI if they are stale. **Never
hand-edit `generated.ts`** — the next regeneration silently discards the edit.

## Branches and commits

Short scoped branch names (`stage-2/screenshot-capture`, `docs/setup-guide`), imperative
commit subjects with a scope (`feat(privacy): resolve overlapping spans`,
`test(backend): cover malformed action responses`).

## Phase-gate discipline

Work follows Build Specification §0.1. Implement one scoped task, run that task's stated
test, then check its box and record the date, what was tested, the result and any caveat.

A checked box means **built and tested**, never attempted. If something is implemented but
its acceptance criterion has not actually been met, leave the box unchecked and say why in
the Notes — an empty box is a signal, not a failure. Several tasks are currently in exactly
that state and the reasons are written down; keep it that way rather than rounding up.

## Documentation changes with the code

Update the doc that describes a behaviour in the same change that alters it. The docs
carry a "last verified" date and are expected to describe what has been run, not what is
intended. If you cannot verify a claim, write what _is_ verified and mark the rest.

## Privacy-sensitive changes

Anything touching the DOM walker, Privacy Firewall, Context Builder, the server payload,
the Action Executor or the audit trail needs a focused test showing that raw values do not
cross the boundary. Start from the existing regression suites:

| Suite                         | Guards                                                    |
| ----------------------------- | --------------------------------------------------------- |
| `tests/credentials.test.ts`   | No `<input>` value is ever read, credential or otherwise. |
| `tests/privacy.test.ts`       | Overlapping/adjacent PII of different types.              |
| `tests/piiCorpus.test.ts`     | 30 PII samples / 30 near-miss controls.                   |
| `tests/contextBudget.test.ts` | Serialized payloads contain no raw PII.                   |
| `e2e/loop.spec.ts`            | What actually leaves a real browser, on the wire.         |

Two of these exist because of confirmed, reproduced defects — a password transmitted in
plaintext, and overlapping detectors corrupting output. Do not weaken them.

## A note on tests that pass while nothing works

An earlier build had 41 green tests, clean lint and clean types, and no working software:
every module mocked its neighbour, and the client had never called the server. Loading the
extension in a real browser later found two more defects that no unit test could see — the
service worker running the content script's bundle, and both message listeners answering
each other's messages.

So: when adding a capability, add at least one test that exercises it through a real
boundary — real HTTP, a real browser, or the real pipeline — not only a unit test with its
neighbours stubbed.
