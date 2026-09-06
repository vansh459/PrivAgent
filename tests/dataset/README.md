# PrivAgent evaluation dataset

Version 1.0 · captured and annotated 2026-09-06 · 42 screens

This is the dataset every Phase 8 number is measured against. It exists so that one
command produces one set of figures over one versioned set of pages, rather than each part
of the system being scored on the fixture it was built with.

## What is in it

| Path                   | What it holds                                                        |
| ---------------------- | -------------------------------------------------------------------- |
| `sites.json`           | The curated capture list: id, site type, URL.                        |
| `personas.json`        | Twelve synthetic identities. The people are not real.                |
| `screens/<id>.html.gz` | The frozen page, gzipped. Served over HTTP at evaluation time.       |
| `screens/<id>.json`    | Ground truth for that screen.                                        |
| `screens/<id>.jpg`     | Reference screenshot of the annotated page, for human review.        |
| `screens/sources.json` | Provenance: URL, final URL, title, HTTP status, capture time, sizes. |
| `screens/index.json`   | Totals across the set.                                               |
| `faces/`               | Five public-domain NASA portraits and their provenance.              |

Totals: **42 screens · 3 964 ground-truth interactive elements · 400 labelled PII spans ·
42 labelled faces · 84 labelled pixel-text regions.**

Site types: 13 government/public portals, 6 finance, 8 e-commerce, 5 forms, 4 SPAs,
6 dashboards.

## Regenerating it

```bash
node scripts/capture-dataset.mjs     # network; rewrites screens/*.html.gz and sources.json
node scripts/annotate-dataset.mjs    # offline; injects the labels and writes screens/*.json
```

Capture needs the internet and produces a different dataset every time it runs, because
the sites change. Annotation is deterministic: the same snapshots and the same personas
produce byte-identical ground truth, because every placement is drawn from a PRNG seeded
with the screen's id.

## The three things a reader should know before trusting a number from it

### 1. The pages are real. The people in them are not.

Every screen is a capture of a real, public, logged-out page — an actual government
portal, an actual bank homepage, an actual storefront — with the nested navigation,
duplicated links, icon-only buttons and generated markup that real sites have and hand-made
fixtures do not. That is the whole reason for capturing rather than authoring: a system
scored only on pages its own authors wrote is scored on its authors' idea of a web page.

But a logged-out page contains no personal data, so there would be nothing to detect. The
PII is therefore **injected and synthetic**: twelve personas from `personas.json`, written
into real elements of those real pages. Aadhaar numbers are format-valid but unissued, card
numbers are the published test numbers no issuer will ever assign, and the names and
addresses are invented. Using a real person's identifiers to benchmark a redaction tool
would be indefensible whatever a licence permitted.

The formats are deliberately mixed. Alongside the shapes the detectors were written for
there are shapes they are likely to miss — `+91 98123 45670` with an internal space,
landline forms like `080 2345 6789`, Aadhaar with no separators. A dataset containing only
the formats a regex already handles measures nothing about the regex.

### 2. The element ground truth is an independent oracle, not a hand annotation.

`elements` in each screen's JSON comes from Chrome's own accessibility tree, read over CDP
(`Accessibility.getFullAXTree`), filtered to roles a user can act on, with boxes from
`DOM.getBoxModel`. It is a different computation from this project's DOM walker — written
by different people, for a different purpose — which is what makes agreement with it worth
measuring.

It is **not** independent of the DOM. Both read the same document, so it can say whether
PrivAgent sees what Chrome's accessibility layer sees; it cannot say whether either of them
describes what is actually painted. The parts of perception no DOM oracle can score — text
that exists only as pixels, and faces — are covered by the composited regions instead,
where the truth is the string that was drawn and the rectangle it was drawn into.

Disagreements with the oracle are expected and are reported by category rather than
averaged away: PrivAgent perceives `[tabindex]` containers the accessibility tree ignores,
and the accessibility tree exposes some roles PrivAgent does not treat as actionable.

### 3. The snapshots are inert and offline, and the faces are not all labelled.

Each snapshot has had every `<script>`, `<iframe>`, `<noscript>` and preload hint removed;
stylesheets are inlined; images are inlined as data URIs where the site allowed it and
replaced by a same-sized grey placeholder where it did not; and every CSS `url(...)` is
neutralised. Nothing in a snapshot can execute, and nothing in it reaches the network. The
evaluation serves them from `127.0.0.1` and blocks all outbound requests, which also means
the benchmark for a privacy tool cannot itself phone home.

One consequence worth stating: **several captured pages contain real photographs of real
people**, in banners and hero images that were inlined. Those faces are not in
`vision.faces`, which lists only the portrait composited in by the annotator at a known
rectangle. Face _recall_ is therefore measured against the labelled portraits and is exact;
face _precision_ is reported separately, with the extra detections reviewed by hand against
the reference screenshots, because counting a correctly-detected real face as a false
positive would be the wrong answer.

## Licensing and provenance

The captured pages are third-party content, and the snapshots are **committed to this
repository**, which is public — so they are redistributed, and it is better to say that
plainly than to describe them as merely "held". They are here for one reason: an evaluation
whose dataset cannot be cloned cannot be checked, and every number in `results.md` would
otherwise be unverifiable by anyone but the author.

The terms under which that is done, and their limits:

- Only **public, logged-out** pages were captured. Nothing behind a login, a paywall or a
  consent gate.
- The snapshots are **inert**: no scripts, no frames, no outbound requests. They cannot
  function as a working copy of anyone's site, and they are not served as one.
- They are held **for non-commercial academic evaluation of this project**, not as a mirror,
  an archive or a redistribution of anyone's content for its own sake.
- **Provenance for every screen** — the URL requested, the URL finally served, the page
  title, the HTTP status and the capture timestamp — is in `screens/sources.json`.
- **Any page can be removed on request, or on second thoughts.** Drop it from `sites.json`,
  re-run the annotator, and record the removal in `sources.json` — the drop belongs in the
  file, not in silence.

The five face crops in `faces/` are public-domain NASA portraits; see `faces/sources.json`.
