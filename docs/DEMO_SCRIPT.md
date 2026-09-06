# PrivAgent demo script

Extension 0.3.0 · last updated 2026-09-06 · **automated rehearsal: passing (two consecutive
passes). Human rehearsal: not yet done.**

Every step below is executed by `extension/e2e/demo.spec.ts`, twice in a row, against a real
browser, and every number quoted is asserted by that test. So the flow is known to work and
the figures are known to be current. What has _not_ happened is two clean run-throughs by a
person, which is what Build Spec Phase 9.3 actually asks for — until that is done, do not
describe this as rehearsed.

A recording of the automated rehearsal is at [`demo/privagent-demo.webm`](./demo/privagent-demo.webm),
which is the Phase 9.4 backup. Regenerate it with `npx playwright test e2e/demo.spec.ts`.

## Before you start

```bash
npm ci --prefix extension
pip install -r server/requirements-dev.txt
npm run build                                    # both targets + manifest validation
python -m uvicorn app.main:app --app-dir server --port 8000
curl http://127.0.0.1:8000/health                # confirm, and note which provider is active
```

Load `extension/dist/chrome` unpacked. Serve the two fixture pages over HTTP — a `file://`
URL will not do, content scripts need an http origin:

```bash
npx serve extension/e2e/fixtures      # or any static server on 127.0.0.1
```

Have open and ready: the popup, and DevTools on the page (Network and Application tabs).

**Optional, and worth it if the room is patient:** start Ollama with `qwen2.5:1.5b` and run
the server with `PRIVAGENT_REASONER=ollama`. The whole loop then runs on the machine in
front of you, with no network at all. It costs about ten seconds per task — see the closing
note.

---

## The four-minute version

### 1. The problem — 25 seconds

> "An agent that can act on your screen has to see your screen. Send that to a server and
> your passwords, your Aadhaar number and your card details leave your machine — and the
> screenshot doesn't come back. PrivAgent does the seeing and the redacting on the device,
> and sends the server only what it needs in order to decide."

### 2. Run a task — 40 seconds

Open `report-portal.html`. Type a username and a password into the login form, so the room
can see there is something to protect. Popup → `download report` → **Run task**.

The link is clicked. Then read the privacy summary out loud, because it is the whole
argument:

> "Six elements perceived. Four transmitted. Three redacted. The password field was never
> even read."

(Those are the real numbers on this fixture, asserted by the rehearsal test.)

### 3. Show what actually left — 60 seconds

DevTools → Network → the `/reason` request → Payload.

Point at three things, in this order:

- **The password is not there, and neither is the field's value.** Credential fields are
  dropped during _extraction_, not during redaction — the value is never read at all, so
  there is nothing to leak later.
- **The Aadhaar number, the card number and the support phone number are not there either.**
  Those live in a `role="note"` region that is not relevant to this task, so the context
  builder withheld the whole element rather than sending a redacted version of it.
- **Run `request callback` and look again.** Now the phone number _is_ needed, so the
  element is transmitted — as `Request callback on [PII_PHONE_01]`. The token is stable
  within the task and the map from token to value never leaves the client's memory.

> "Redaction isn't deletion. The agent can still act on a field it is not allowed to read."

### 4. The half a DOM cannot see — 60 seconds

Open `claims-review.html`. It has two things no text-only privacy filter can handle: a
photograph carrying a face, and a `<canvas>` whose text exists only as pixels. Neither has
alt text, deliberately — an author's description is a claim about an image, not an
observation of it.

Popup → `check the settlement total` → **Run task**.

> "Five elements perceived, two of them by vision. One face detected — and never sent."

DevTools → the `/reason` payload again:

- **`Settlement total 84,200` is in it.** That string appears in no text node and no
  attribute anywhere on the page. It was read off the screen, on the device, by OCR.
- **The face is not.** It was detected, painted out of the screenshot buffer _before_ OCR
  read from the same pixels, and withheld from the payload entirely.

> "Anything vision reads goes through the same privacy firewall as anything the DOM reads.
> It enters by the same door, so it can't get round it."

### 5. When it should ask first — 30 seconds

The server proposes a `navigate` action and labels it low risk. The client scores it high —
`max(server, local)`, so a server can raise risk but never lower it — and the confirmation
prompt appears on the page, in a closed shadow root the page cannot read or restyle.

Press **Escape**. Nothing happens, and the audit trail records `denied_by_user`.

> "Approving is Ctrl+Enter. Denying is Escape. That asymmetry is deliberate: dismissing has
> to be the reflex."

### 6. The trail — 25 seconds

Popup → the stage list: observe, detect PII, redact, reason, validate, act — six entries for
every task, successful or not.

Then, in DevTools → Application on the _visited page_: its `localStorage` holds only the key
the page itself wrote, and it has no `privagent` IndexedDB database. The trail lives on the
extension's origin, not the site's.

> "Every entry is a count or a status. A detector runs over each one before it is written,
> and refuses to store anything that matches. The trail cannot become the leak."

---

## The numbers, if you are asked

All from [`results.md`](../results.md), measured over 42 real captured pages:

- Interactive elements: **F1 92.2%** against Chrome's own accessibility tree.
- Text that exists only as pixels: **97.3%** character accuracy.
- PII: **100% recall**, 69.8% precision.
- **Zero** of 400 identifiers or contact details reached the wire. Zero faces.
- **960 ms** median task, warm, without a model in the loop.

## The closing note, and do not skip it

> "With a local 1.5-billion-parameter model doing the reasoning, a task takes about ten
> seconds instead of one. The model _is_ the latency. We could make that number look better
> by sending your screen to a datacentre with a GPU in it — which is exactly the thing this
> project exists not to do."

---

## If something goes wrong on stage

| Symptom                                | What it is                                             | What to do                                              |
| -------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| Popup sits on "Perceiving the page..." | The page under test is not the frontmost window        | Click the page, then run the task again                 |
| First task takes several seconds       | Cold start: 33 MB of model, runtime and language data  | Open the popup once before you begin; it preloads them  |
| "Could not reach the reasoner"         | The FastAPI server is not running, or the URL is wrong | Check `/health`; the URL is under Settings in the popup |
| Nothing is redacted                    | You are on the wrong fixture                           | `report-portal.html`, not the claims page               |
| Vision reports zero regions            | You are on the portal fixture, which has no images     | That is correct behaviour — say so, then switch pages   |

Fall back to [`demo/privagent-demo.webm`](./demo/privagent-demo.webm) rather than debugging
in front of the room.
