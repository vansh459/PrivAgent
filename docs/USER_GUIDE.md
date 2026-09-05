# PrivAgent User Guide

Extension 0.2.0. Last updated: 2026-09-04.

> **Prototype.** Built for SIH evaluation. Do not run it against accounts or data you
> cannot afford to expose.

## Installing

See [SETUP_GUIDE.md](./SETUP_GUIDE.md). In short: build the extension, load
`extension/dist/chrome` unpacked in Chrome or `extension/dist/firefox/manifest.json` in
Firefox, and start the reasoner on `http://127.0.0.1:8000`.

## Running a task

Click the toolbar icon, type what you want done in plain language, and press **Run task**.
Tasks are single steps against the page you are looking at:

- `download report`
- `open the reports section`
- `click continue`

The agent reads the page you have open. It does not browse, and it does not chain steps —
one task, one action.

## Reading the privacy summary

After a task, the popup shows:

| Row                     | Meaning                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Elements perceived**  | Interactive elements found on the page. Credential fields are already excluded — they are never counted because they are never read. |
| **Marks transmitted**   | How many of those were actually sent. Always ≤ perceived.                                                                            |
| **Elements redacted**   | How many contained structured PII that was replaced with a token.                                                                    |
| **Withheld for review** | Elements held back entirely because a detection was borderline. These were **not** sent.                                             |
| **Action**              | What the reasoner proposed, and its risk tier.                                                                                       |
| **Outcome**             | `executed`, `denied_by_user`, `skipped`, or `failed`.                                                                                |

The gap between _perceived_ and _transmitted_ is the point of the tool. If 34 elements were
perceived and 6 transmitted, 28 never left your machine.

## Confirmations

Actions are scored `low`, `medium` or `high` risk from the action type, how confident the
reasoner was, and whether the target is sensitive.

- **Low** — executes immediately.
- **Medium / high** — a prompt appears in the page, bottom right, naming the action and the
  reasoner's explanation. Nothing happens until you press **Allow**. `Escape` denies;
  approving by keyboard needs `Ctrl+Enter`, deliberately harder than dismissing.

`type` is at least medium. `navigate` is always high. Low confidence escalates the tier.

The server proposes a risk tier, but the extension takes the **stricter** of that and its
own assessment. A server that says "low risk" cannot make a navigation execute silently.

## The audit trail

Every task records six stages: **observe → detect_pii → redact → reason → validate → act**.
The popup lists them with a one-line summary each.

The trail is stored in the extension's own storage, never the website's, so a site you
visit cannot read what the agent saw or redacted there. Entries hold counts and statuses
only — never the values themselves. An attempt to write a detail containing PII is
rejected rather than stored.

## What the server sees

One JSON payload per task, containing your task text and a list of elements with a mark id,
role, label and position:

```json
{
  "schema_version": "1.0",
  "task": "download report",
  "elements": [
    {
      "mark_id": "M1",
      "role": "link",
      "text": "Download report",
      "bbox": [820, 640, 160, 40]
    }
  ]
}
```

It never receives: screenshots, the page URL, the raw DOM, anything you typed into a field,
or the mapping from tokens back to real values.

Text like `Contact [PII_PHONE_01]` means a phone number was found there and replaced. The
server can reason about the field's presence without learning the number.

## Limitations

Real, current limitations — not a disclaimer:

- **Login forms cannot be filled.** Credential fields are excluded from perception
  entirely, so the agent cannot see or type into them. This is deliberate.
- **DOM only.** Content inside `<canvas>`, video, images or cross-origin iframes is
  invisible to the agent. Screenshot capture and on-device vision models are Stage 2.
- **The reasoner is not a language model yet.** A deterministic keyword matcher stands in,
  so it handles direct phrasing ("download report") and declines anything indirect rather
  than guessing.
- **Unstructured PII is not detected.** Names and addresses in free text are not redacted;
  only Aadhaar, PAN, phone, email, card and OTP patterns are.
- **One step at a time.** No multi-step task loop.
- **Firefox is less tested than Chrome.** The end-to-end suite runs against
  Chromium-based browsers only, because Playwright cannot load extensions in Firefox. The
  Firefox build is checked for manifest correctness but not driven end to end.
