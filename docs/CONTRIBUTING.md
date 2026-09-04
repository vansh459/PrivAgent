# Contributing to PrivAgent

Last updated: pre-implementation documentation scaffold.

This guide defines the planned collaboration process for PrivAgent.

## Branches and commits

Use short scoped branch names such as `phase-1/dom-walker` or `docs/setup-guide`. Use imperative commit subjects with a scope, for example `feat(privacy): add PAN detector` or `test(backend): cover malformed action responses`. Exact repository protections are `TBD`.

## Phase Gate discipline

Work follows the Build Specification §0.1. Implement one scoped task, write and run that task's stated test, then check its task box and record the date, test, outcome, and caveats in Notes. Do not begin the next task until the current task passes; do not start a phase until the preceding Phase Gate closes.

## Before opening a pull request

Run the relevant lint, typecheck, unit, integration, E2E, and benchmark commands once those commands exist. Include the task number, test evidence, and any deviation from the specification in the PR description. Do not claim completion without passing evidence.

## Privacy-sensitive changes

Changes affecting the Privacy Firewall, Context Builder, server payloads, Action Executor, or Audit Trail require focused tests demonstrating that raw PII does not cross the intended boundary (see Build Spec §2, Phases 3–4, 7).
