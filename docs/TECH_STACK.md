# PrivAgent Technology Stack

Last verified: 2026-09-04. Versions are what is actually installed and passing, taken from
the lockfiles — not what was once planned.

Developed on Node 24.16.0 / Python 3.12.10. CI runs Node 20 and Python 3.12.

## In use

| Layer                  | Choice                             | Version          | Why                                                                                                                |
| ---------------------- | ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Extension manifest     | Manifest V3                        | —                | Required by Chrome; Firefox 128+ supports it.                                                                      |
| Cross-browser layer    | `webextension-polyfill`            | 0.12.0           | One codebase, promise-based APIs in both browsers.                                                                 |
| Build tooling          | Vite + CRXJS                       | 8.2.2 / 2.7.1    | MV3-aware bundling; per-target builds from one config.                                                             |
| Language               | TypeScript (strict)                | 5.9.3            | `noUncheckedIndexedAccess` and friends across a multi-stage pipeline.                                              |
| Client validation      | Zod                                | 4.1.13           | Generated from the server's Pydantic models; validates at the network boundary.                                    |
| Backend                | FastAPI + uvicorn                  | 0.141.1 / 0.41.0 | Async, Pydantic-native, easy to put a model behind.                                                                |
| Contract               | Pydantic v2 → JSON Schema → TS/Zod | 2.13.4           | One source of truth; CI fails on drift.                                                                            |
| Audit storage          | IndexedDB                          | —                | On the extension origin. See [SECURITY.md](./SECURITY.md#guarantee-3--the-audit-trail-stays-inside-the-extension). |
| Unit/integration tests | Vitest + jsdom                     | 4.x / 27.x       | Fast; the integration test spawns the real server.                                                                 |
| Coverage               | `@vitest/coverage-v8`              | 4.x              | Enforced ratchet, see [TESTING.md](./TESTING.md#coverage).                                                         |
| IndexedDB in tests     | `fake-indexeddb`                   | 6.2.2            | jsdom has no IndexedDB.                                                                                            |
| Browser E2E            | Playwright                         | 1.56.1           | Chromium only — it cannot load extensions in Firefox.                                                              |
| Backend tests          | pytest + httpx                     | 9.0.2 / 0.28.1   | FastAPI `TestClient`.                                                                                              |
| Lint / format          | ESLint 10 + Prettier 3.9.6         | —                | `typescript-eslint` 8.69.                                                                                          |

## Installed, staged, not yet wired

Present in the dependency tree and covered by tests, but not part of the running pipeline.
Stage 2 wires them.

| Layer            | Choice           | Version | State                                                                                                                                                                                 |
| ---------------- | ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local ML runtime | ONNX Runtime Web | 1.29.0  | Backend selection (WebGPU → WASM) works and is tested. No real model runs; the only bundled asset is a 100-byte Identity graph. **Its `.wasm` files must be self-hosted** before use. |
| OCR              | Tesseract.js     | 7.0.0   | Wrapper written; tests inject a fake worker. **Defaults to fetching its worker and `eng` traineddata from a CDN** — must be vendored before this path is enabled.                     |

## Chosen but not yet installed

| Layer              | Planned choice                                      | Notes                                                                                                                                                                     |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server LLM         | Ollama + a local open-weight model                  | Behind the existing `ReasonProvider` protocol, with the deterministic matcher kept as the CI/offline fallback. Satisfies the "offline deployable open-weight" constraint. |
| Face detection     | YuNet ONNX (~340 KB), BlazeFace as alternative      | Replaces the `FaceDetector` Shape Detection API, which is absent from Chrome desktop stable and all Firefox.                                                              |
| Object detection   | YOLOv8n ONNX                                        | For image regions, feeding face/ID-photo masking.                                                                                                                         |
| Model distribution | `npm run fetch:models`, SHA-256 pinned, git-ignored | Keeps tens of MB of weights out of git history while making provenance checkable.                                                                                         |
| Firefox packaging  | `web-ext`                                           | Also the only route to a Firefox smoke test, since Playwright cannot load extensions there.                                                                               |

## Deliberately not used

| Considered                     | Decision                                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React + Tailwind for the popup | Plain TypeScript and CSS. The popup is a form, a summary table and a list; a framework would add build weight and no capability.                        |
| Docker                         | Removed in Phase 0. The server is a local-by-default uvicorn process; a container added a dependency without solving a problem.                         |
| A UI-element-detection ViT     | Deferred, and stated as deferred. Training one needs labelled UI data we do not have. OCR plus object detection covers the rubric line honestly.        |
| Local NER for unstructured PII | Deferred to a Stage 2 stretch. Regex plus field-level exclusion covers structured PII and credentials first, which is where the confirmed defects were. |
