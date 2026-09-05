# PrivAgent Demo Script

Extension 0.2.0. Last updated: 2026-09-04.

> **Not yet rehearsed by a person.** Every step below is executed automatically by
> `extension/e2e/loop.spec.ts` against a real browser, so the flow is known to work — but
> Build Spec Phase 9.3 requires two clean human rehearsals before this is demo-ready. Do
> not present it as rehearsed.

## Before you start

```bash
npm ci --prefix extension
pip install -r server/requirements-dev.txt
npm run build                 # both targets + manifest validation
python -m uvicorn app.main:app --app-dir server --port 8000
curl http://127.0.0.1:8000/health     # confirm, and note the provider
```

Load `extension/dist/chrome` unpacked. Open `extension/e2e/fixtures/report-portal.html`
through a local HTTP server — a `file://` URL will not do, content scripts need an http
origin.

The fixture is built for this demo: a `role="note"` region carrying a phone number, an
email, an Aadhaar number and a card number; a `role="status"` line with another phone
number; a login form with a password field; a download link; and a "Request callback on
9876543210" link — one PII value that the agent _does_ need, so it is tokenized rather
than withheld.

Have open, ready to show: the popup, and DevTools on the page (Application and Network
tabs).

## The three-minute version

**1. The problem (20s).** "An agent that can act on your screen has to see your screen. Sent
to a server, that means your passwords, your Aadhaar number and your card details leave
your machine. PrivAgent does the seeing and the redacting on-device, and sends the server
only what it needs to decide."

**2. Run a task (40s).** Popup → `download report` → **Run task**. The link is clicked.

Then read the privacy summary out loud, because this is the whole argument:

> "Six elements perceived, four transmitted, three redacted. Two never left the machine at
> all, and the one that did went as a token."

(Those are the real numbers from this fixture, asserted by the e2e suite.)

**3. Show what was actually sent (60s).** DevTools → Network → the `/reason` request →
Payload:

```json
{
  "schema_version": "1.0",
  "task": "download report",
  "elements": [
    {
      "mark_id": "M1",
      "role": "text_field",
      "text": "Username",
      "bbox": [77, 117, 170, 21]
    },
    {
      "mark_id": "M2",
      "role": "link",
      "text": "Download report",
      "bbox": [8, 139, 109, 18]
    },
    {
      "mark_id": "M3",
      "role": "link",
      "text": "Request callback on [PII_PHONE_01]",
      "bbox": [121, 139, 213, 18]
    },
    {
      "mark_id": "M4",
      "role": "button",
      "text": "Cancel",
      "bbox": [338, 138, 57, 21]
    }
  ]
}
```

That is a real captured payload, not an illustration.

Three things to point at, in order:

1. **No password field at all.** Not redacted — never perceived. Excluding it at extraction
   means there is no code path on which its value could have been read.
2. **The Aadhaar, card and email are simply absent.** Those regions were perceived and
   redacted, then withheld entirely as not task-relevant. Redaction is the second line of
   defence; not sending is the first.
3. **M3 is the interesting one.** The agent _needs_ that link to act, so it was
   transmitted — as `Request callback on [PII_PHONE_01]`. The server learns that there is a
   phone number and what the control does, and never learns the number.

**4. The confirmation gate (30s).** Run a task that produces a `navigate`. The prompt
appears in the page; the reasoner's own explanation is shown. Press **Deny** — nothing
happens; the audit trail records the denial.

Worth saying: "The server proposed low risk here. The client scored it high and the client
won. A compromised server can escalate risk, never lower it."

**5. The audit trail (30s).** Six stages in the popup. Then the punchline, in DevTools →
Application → Storage, **on the page's origin**: the page's own `localStorage` holds only
what the page wrote, and there is no `privagent` database. The trail lives on the
extension's origin, so the site you are on cannot read what the agent saw there.

This is asserted directly by the e2e suite, not just demonstrated — it is the one privacy
property that no unit test could establish.

## The PII redaction close-up

If you have longer, the strongest single moment is the adjacent-PII case. Run
`npx vitest run tests/privacy.test.ts` and show this line from the suite:

```
in : Aadhaar 1234 5678 9012 and card 4111 1111 1111 1111
out: Aadhaar [PII_AADHAAR_01] and card [PII_CARD_01]
```

Two different PII types, adjacent, and the card's first twelve digits are themselves
Aadhaar-shaped. An earlier build got this wrong: it labelled the card `[PII_AADHAAR_01]`
and ate six characters of the surrounding sentence. Five regression tests now cover exactly
these overlapping cases, plus a 30-sample / 30-control corpus with 100% recall and zero
false positives.

Worth stating plainly: this was a real defect found by running the code, not a hypothetical.
The tests exist because it happened.

## What to say when asked what is missing

Answer these directly; they are the obvious questions and evasion costs more than candour.

**"Where is the vision model?"** Not built. Perception today is DOM and accessibility-tree
extraction. Screenshot capture, OCR, face and object detection are Stage 2, and the
architecture is already staged for them — the fusion engine and runtime selection are
written and tested, and the manifest already carries the `tabs` permission and the WASM CSP
they need. Until a real model runs on real pixels, we call this a DOM agent.

**"Is that a real LLM?"** No. A deterministic keyword matcher, behind a provider interface,
so the endpoint and client do not change when a real model lands. `/health` reports which
provider is active — check it before demoing.

**"What if redaction fails?"** Three layers. Credential fields are never read at all.
Detected PII is tokenized. Anything the confidence gate finds borderline is withheld
entirely rather than sent. And the payload is schema-validated immediately before `fetch`,
with the server rejecting unknown fields — so a leak has to defeat both ends.

## Fallback

If the live demo fails, run `npm run test:e2e --prefix extension` — the same flow, driven
automatically in a real browser, in about 15 seconds. Failing that, `npm test` (210 client
and 14 server tests, including the credential and overlapping-PII regression suites) and
walk the captured payload in [SECURITY.md](./SECURITY.md).

A recorded backup video (Build Spec Phase 9.4) has not been made yet.
