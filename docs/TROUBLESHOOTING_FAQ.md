# PrivAgent Troubleshooting

Entries here are problems actually hit during development or setup, with the fix that
worked. Nothing speculative.

## Setup and build

**`npm test` fails at the schema drift check.**

```
Generated schema output is stale:
  extension/src/schemas/generated.ts
Run `npm run gen:schemas` and commit the result.
```

`server/app/schemas.py` changed without regenerating, or `generated.ts` was hand-edited.
Run `npm run gen:schemas` and commit both it and `schemas/privagent.schema.json`. Never
edit `generated.ts` directly.

**The schema generator cannot find Python.**
`scripts/gen-schemas.mjs` shells out to Python to export the Pydantic models. It prefers
`server/.venv` and otherwise falls back to `python`/`python3` on `PATH`. Install the server
requirements first: `pip install -r server/requirements-dev.txt`.

**`prettier --check` fails on files nobody wrote.**
Playwright writes `test-results/` and `playwright-report/`. Both are in `.prettierignore`
and `.gitignore`; if you see them flagged, your working copy predates that change.

**`npm install` pulls the repo into itself.**
`extension/package.json` used to declare `"privagent": "file:.."` — the extension depending
on its own monorepo root. Removed in 0.2.0. If an old `node_modules` still has it, delete
`extension/node_modules` and run `npm ci --prefix extension`.

## Extension behaviour

**Nothing happens when I run a task in Firefox.**
Firefox MV3 treats `host_permissions` as opt-in. Open the add-on's permissions panel and
grant site access; until then the content script does not run.

**Loading the extension fails with a background-script error.**
The two builds are not interchangeable. Chrome MV3 needs `background.service_worker`;
Firefox MV3 needs `background.scripts` with an event page. Load `dist/chrome` in Chrome and
`dist/firefox` in Firefox. `node scripts/verify-manifests.mjs` checks both after a build.

**The popup reports `Could not reach the reasoner at http://127.0.0.1:8000`.**
The server is not running, or is on another port. Check
`curl http://127.0.0.1:8000/health`, and set the URL under **Settings** in the popup.

**The agent will not fill my login form.**
Working as designed. Credential fields are excluded from perception entirely — see
[SECURITY.md](./SECURITY.md#guarantee-1--credential-values-are-never-read). The agent
cannot see them, so it cannot type into them.

**The action came back as `none`.**
The reasoning provider is a deterministic keyword matcher, not a model. It matches task
words against clickable element labels and declines rather than guessing. Phrase the task
using words that appear on the page ("download report" for a link labelled _Download
report"_). Stage 2 replaces it with a real model.

**A task failed with `stale_target`.**
The page changed between perception and execution, so the mark the server named no longer
resolves to a live node. This is deliberate — the alternative is clicking whatever now
occupies that position. Re-run the task.

## Local inference (Stage 2 groundwork)

**Tesseract or ONNX Runtime tries to reach a CDN.**
Both resolve assets remotely by default: Tesseract from `cdn.jsdelivr.net` for its worker
and `eng` traineddata, ONNX Runtime for its `.wasm` binaries. In a privacy tool that is a
leak in itself, and MV3's CSP blocks it anyway. Assets must be vendored and every path
pointed at `browser.runtime.getURL(...)`. Not yet done — see
[SECURITY.md](./SECURITY.md#guarantee-5--no-third-party-network-calls-from-local-inference).

**WASM fails to instantiate with a CSP error.**
The manifest needs `content_security_policy.extension_pages` to include
`'wasm-unsafe-eval'`. It is set; if you changed the manifest, keep it.

## Tests

**`tests/integration/reason.integration.test.ts` times out.**
It spawns the real FastAPI app. Install the server requirements and make sure nothing else
holds the port it picked (it selects a free one, so this is usually a missing `uvicorn`).

**Playwright: `Executable doesn't exist at …chromium-1194\chrome-win\chrome.exe`.**
The installed Chromium revision does not match what this Playwright version wants. Run
`npx playwright install chromium` from `extension/`. If it reports a `__dirlock` error, a
previous install is still running or crashed — wait for it, or remove
`%LOCALAPPDATA%\ms-playwright\__dirlock` and retry.

**Playwright cannot load the extension in headless mode.**
Extensions need a full headed Chromium; the headless shell cannot load them. The config
launches headed deliberately.

**Playwright cannot test Firefox.**
It cannot load extensions in Firefox at all. Firefox needs `web-ext run` instead — not yet
written. What is verified today is that the Firefox build emits the correct manifest shape.

## Development notes

**`CSS.escape is not a function` in a jsdom test.**
jsdom does not implement `CSS.escape`. `domWalker` uses the form control's own `.labels`
property instead of building a `label[for=…]` selector, which is both simpler and avoids
the dependency.

**Audit stages come back in the wrong order.**
They used to be sorted by ISO timestamp, which is millisecond-resolution — several stages
routinely land in the same millisecond and then sort arbitrarily. The store now uses an
auto-increment key, so storage order is insertion order.
