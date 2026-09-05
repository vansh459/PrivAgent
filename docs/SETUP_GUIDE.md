# PrivAgent Setup Guide

Last verified: 2026-09-04 on Windows 11, Node 20, Python 3.12.10. Every command below was
run against a clean copy of the tree; the outputs shown are real.

## Prerequisites

| Requirement | Version used    | Notes                                         |
| ----------- | --------------- | --------------------------------------------- |
| Node.js     | 20+             | `engines` requires `>=20`.                    |
| Python      | 3.12.10         | 3.11+ should work; only 3.12 has been run.    |
| Chrome      | any MV3-capable | For loading the unpacked build.               |
| Firefox     | 128+            | `strict_min_version` in the Firefox manifest. |

No Docker. No cloud account. No API key.

## 1. Install

```bash
npm ci --prefix extension
pip install -r server/requirements-dev.txt
```

Recorded output:

```
added 250 packages in 27s
```

Use `npm ci`, not `npm install` — the lockfile is committed and CI installs from it.
Install `requirements-dev.txt` rather than `requirements.txt`: the dev file adds `pytest`
and `httpx`, and the client integration test spawns the real server.

## 2. Verify before running anything

```bash
npm test
```

This runs, in order: schema drift check → lint → typecheck → format check → 210 client
tests with a coverage gate → 14 server tests. It is exactly what the main CI job runs.

For the browser suite (a separate CI job, and the thing that backs the privacy claims):

```bash
npm run build:chrome --prefix extension
npm run test:e2e --prefix extension
```

It prefers Playwright's bundled Chromium and falls back to a locally installed Edge or
Chrome, so it runs without a 150 MB download. Override with `PRIVAGENT_E2E_CHANNEL`.

If the schema check fails, someone edited `extension/src/schemas/generated.ts` by hand or
changed `server/app/schemas.py` without regenerating. Fix with:

```bash
npm run gen:schemas
```

## 3. Start the reasoner

```bash
npm run dev
```

That starts the Vite dev server and uvicorn together. To run only the server:

```bash
python -m uvicorn app.main:app --app-dir server --host 127.0.0.1 --port 8000
```

Confirm it is up, and check which reasoning provider is active:

```console
$ curl http://127.0.0.1:8000/health
{"status":"ok","provider":"deterministic"}
```

`provider` is `deterministic` today — a keyword matcher, not a model. Stage 2 adds an
Ollama-backed provider. If you are demoing, say which one is running.

## 4. Build the extension

```bash
npm run build:chrome --prefix extension     # → extension/dist/chrome
npm run build:firefox --prefix extension    # → extension/dist/firefox
```

Or `npm run build` from the repo root for both, plus manifest validation:

```
Both manifests are valid for their target browser.
```

The two targets are not interchangeable. Chrome MV3 requires
`background.service_worker`; Firefox MV3 requires `background.scripts`. Loading the wrong
directory fails at load time.

## 5. Load it

**Chrome** — `chrome://extensions` → enable _Developer mode_ → _Load unpacked_ →
select `extension/dist/chrome`.

**Firefox** — `about:debugging#/runtime/this-firefox` → _Load Temporary Add-on_ →
select `extension/dist/firefox/manifest.json`.

> Firefox MV3 treats `host_permissions` as opt-in. Open the add-on's permissions panel and
> grant site access, or the content script will not run.

## 6. Run a task

1. Open any ordinary page with links and form fields.
2. Click the PrivAgent toolbar icon.
3. Type a task, e.g. `download report`.
4. Press **Run task**.

The popup then shows how many elements were perceived, how many marks were transmitted,
how many elements were redacted or withheld, the proposed action with its risk tier, and
the six-stage audit trail.

If the action is above `low` risk, a confirmation prompt appears **in the page**, bottom
right. Nothing executes until you approve it.

To point at a different server, open **Settings** in the popup and set the reasoner URL.

## Verification status of this guide

Steps 1–4 were executed against a clean copy of the tree and the outputs above are recorded
from those runs.

Steps 5 and 6 are verified for **Chromium-based browsers** by the Playwright suite, which
loads this exact unpacked build, opens the real popup, runs tasks and asserts the results:

```bash
npm run build:chrome --prefix extension
npm run test:e2e --prefix extension
```

**Firefox is not verified.** Playwright cannot load extensions in Firefox, so only the
manifest shape is checked (`scripts/verify-manifests.mjs`). The Firefox load steps above
follow from that manifest but have not been performed.

## Troubleshooting

Problems actually encountered during development are recorded in
[TROUBLESHOOTING_FAQ.md](./TROUBLESHOOTING_FAQ.md).
