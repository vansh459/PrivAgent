# PrivAgent Setup Guide

> **Status: PLANNED** — this document describes the intended design from
> `PrivAgent_Build_Specification.md`. It has not yet been verified against a working
> implementation. See the specification's Phase Gates for current build status.

Last updated: pre-implementation documentation scaffold.

This guide records the planned setup path. Exact commands and version requirements are `TBD` until Phase 0 is complete.

## Planned prerequisites

Node.js version `TBD`, Python version `TBD`, Docker `TBD`, Chrome and Firefox versions `TBD`, and a browser configuration supporting the planned extension workflow will be required (see Build Spec §3, Phase 0).

## Intended setup

1. Obtain the repository and install planned extension dependencies.
2. Install planned Python dependencies for the FastAPI server.
3. Configure any future environment variables; names and values are `TBD`.
4. Start the intended backend and verify `/health` once it exists.
5. Build the intended extension and load the unpacked Chrome build.
6. Load the Firefox build through `about:debugging`; Firefox packaging details remain `TBD`.

The planned Phase 0 acceptance criteria require a single-command build, clean lint/typecheck, a healthy FastAPI endpoint, and loading in both browsers (see Build Spec Phase 0.1–0.5).

## Planned setup support

Actual setup errors and fixes will be added only after they are encountered and recorded in phase Notes (see Build Spec §0.1).
