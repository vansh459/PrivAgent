# PrivAgent Technology Stack

> **Status: PLANNED** — this document describes the intended design from
> `PrivAgent_Build_Specification.md`. It has not yet been verified against a working
> implementation. See the specification's Phase Gates for current build status.

Last updated: pre-implementation documentation scaffold.

The table records design choices only. No dependency, version, model file, or hosting configuration has been verified (see Build Spec §3).

| Layer | Planned choice | Intended rationale | Final versions used |
|---|---|---|---|
| Extension manifest | Manifest V3 | Chrome requirement and Firefox MV3 support | TBD |
| Cross-browser layer | `webextension-polyfill` | Single Chrome/Firefox codebase | TBD |
| Build tooling | Vite + CRXJS | Extension development workflow | TBD |
| Language | TypeScript | Strict pipeline contracts | TBD |
| UI | React + Tailwind | Popup or side-panel UI | TBD |
| Local ML runtime | ONNX Runtime Web | WebGPU with WASM fallback | TBD |
| OCR | Tesseract.js or distilled OCR ONNX | Text in non-DOM regions | TBD |
| Local vision | Quantized MobileViT, TinyViT, or small YOLO ONNX | Lightweight local perception | TBD |
| Face detection | BlazeFace ONNX or TF.js | Face bounding boxes for masking | TBD |
| PII NER | Quantized distilled BERT via Transformers.js/ONNX | Unstructured PII detection | TBD |
| Structured PII | Regex library | Aadhaar, PAN, phone, email, card, OTP patterns | TBD |
| Redaction | Canvas masking and DOM tokenization | Visual and semantic privacy controls | TBD |
| Context format | JSON + Set-of-Mark tags | Compact grounded context | TBD |
| Backend | FastAPI/Python | Async, ML-friendly service | TBD |
| Server model | Qwen2-VL or LLaVA-NeXT | Offline-deployable open-weight option | TBD |
| Audit storage | IndexedDB | Local persistence | TBD |
| Tests | Vitest, Playwright, pytest | Unit, E2E, backend coverage | TBD |
| Packaging | `web-ext` and Chrome packer | Cross-browser distribution | TBD |

Any substitutions and their reasons are `TBD` until implementation (see Build Spec §3).
