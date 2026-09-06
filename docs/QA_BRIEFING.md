# Q&A briefing

Build 0.3.0 · 2026-09-06 · **not yet rehearsed aloud by a person** (Build Spec Phase 9.6
asks for that, and it has not happened).

Three questions decide most of the marks. Each answer below is grounded in a specific file
and line, and in a measured number from [`results.md`](../results.md). Answer with the
mechanism first, then the number, then the limitation — in that order. Volunteering the
limitation is what makes the number believable.

---

## 1. "How do you balance vision and the DOM?"

**The short answer.** They are not balanced against each other; they are combined, and the
DOM wins ties. The DOM knows an element's role and label exactly. Vision only infers them,
but it can see things the DOM has no words for: a `<canvas>`, a photograph, a video tile, a
cross-origin frame. So every task runs both, fuses them, and prefers the DOM wherever both
describe the same rectangle.

**The mechanism.**

- `perceiveDom()` walks interactive elements and records role, accessible name and box —
  never a field's _value_ (`content/domWalker.ts`).
- `tryVisionPass()` collects `canvas, video, svg, img, picture, iframe` regions of at least
  32 px, skipping any that already carries `alt`, `aria-label` or `title`: an author's
  description is already in the Screen State, and reading the pixels again would create a
  duplicate (`content/visionPass.ts`).
- `fuseScreenElements()` keeps every DOM element and only those vision elements that do not
  overlap a DOM element at IoU ≥ 0.7 (`content/fusion.ts:15`, `:24`).
- **Vision runs before redaction, not after** (`content/content-script.ts:59-60`). That
  ordering is the guarantee: text read out of a canvas is exactly as sensitive as text read
  out of the DOM, and fusing first is what forces it through the same firewall.

**The numbers.** Elements: F1 92.2% against Chrome's own accessibility tree over 42 real
pages. Pixel-only text: 97.3% character accuracy. Faces: 100% recall on the labelled set. A
vision pass costs a median 274 ms.

**The limitation to volunteer.** Vision is not free and it is not always better. On real
pages the DOM half now costs more than the vision half — 667 ms against 290 ms — because
portals carry hundreds of interactive elements. And face detection on a real photograph at
an angle is materially worse than on a frontal portrait: the ICICI hero image contains three
faces and the detector found one.

---

## 2. "How is borderline PII handled?"

**The short answer.** Every detection carries a confidence, and confidence decides the
outcome. High confidence is masked in place and the element still goes to the reasoner as a
token, so the agent can still act on a field it is not allowed to read. Anything between 0.4
and 0.6 is _not_ a decision — the element is withheld from the payload entirely rather than
sent on a guess.

**The mechanism.**

- `detectPii()` merges structured detectors (Aadhaar, PAN, phone, email, card, OTP) with the
  unstructured name/address recogniser _before_ span resolution, so a name and a phone number
  in the same string cannot corrupt each other's boundaries (`content/privacy.ts:128`).
- `resolveSpans()` reduces overlaps longest-match-first, which is what stops a card number
  being labelled `AADHAAR` (`content/privacy.ts:144`).
- `privacyDecision()` maps confidence to `allow` / `review` / `mask`
  (`content/privacy.ts:158`).
- `buildContext()` drops any element still flagged `sensitive`, which is what "withheld"
  means in the popup (`content/contextBuilder.ts:40`).

**The numbers.** 100% recall over 397 labelled spans. 69.8% precision over 4 483 real
strings — and the twenty-sample borderline set in `tests/borderline.test.ts` verifies that
nothing scoring 0.4–0.6 is silently passed through.

**The limitation to volunteer, and lead with it.** Precision is 69.8%, and 202 of the 212
false positives come from one detector: the rule-based name recogniser fires on Title-Case
noun phrases like "Fixed Deposit" and "Appeal No". That costs capability, not privacy — the
element is withheld rather than mis-sent — but it is the clearest argument for spending
~100 MB on a real NER model, and the seam for that is one function
(`detectUnstructuredPii`). Also worth saying: of 305 detections outside the labelled spans,
**91 were real personal data the sites publish themselves**, including eleven real PANs in
the income-tax portal's own recovery notices.

---

## 3. "What happens when redaction fails?"

**The short answer.** It is designed so that the failure modes are loud and the residual
risk is bounded, because "it never fails" is not a claim anyone should believe. There are
four independent layers, and the one that matters most is that the _client_ re-validates
everything the server says.

**The mechanism, layer by layer.**

1. **Credentials are never read.** Password, one-time-code and card fields are excluded
   during extraction, not during redaction — excluding them later would already be too late
   (`content/domWalker.ts`, `isCredentialField`).
2. **Faces are destroyed in the buffer.** Detected faces are painted out of the screenshot
   _before_ OCR reads from the same pixels, so no face reaches the OCR worker or any later
   consumer (`vision/analyze.ts:169-173`).
3. **Uncertainty withholds rather than guesses.** See question 2.
4. **The audit trail cannot become the leak.** Every audit detail is re-scanned by the PII
   detectors at write time and the write is refused if anything matches, so a bug that put a
   value into a log entry fails loudly instead of persisting it (`audit`, `assertPrivacySafe`).
5. **A server can escalate risk but never reduce it.** `effectiveRisk()` takes
   `max(server, local)`, and anything above low needs an explicit Ctrl+Enter
   (`content/actions.ts:35`, `content-script.ts:104`).

**The numbers.** Across 42 real pages and 400 labelled values: **zero** Aadhaar numbers,
card numbers, OTPs, PANs, phone numbers or email addresses in anything transmitted, and zero
faces described to the server. The pages made zero external requests during the evaluation —
38 attempts blocked.

**The limitation to volunteer.** Redaction did fail three times, on names and addresses
inside container elements whose text runs to hundreds of characters, where the recogniser
will not accept shape-only evidence. Structured identifiers are unaffected. And there is a
known exposure that is documented rather than fixed: **an element whose `aria-label`
disagrees with its visible text is described by the label**, so a page that paints an email
address but names the link "Customer Services" hides that text from the DOM walker entirely.
Only the vision pass catches it.

---

## Questions that will also come

**"Why not just use a bigger model?"** Because the model runs on the user's machine. A 1.5B
model on a CPU already costs ~10 s per task against a ~1 s budget for everything else. A
bigger one is a better answer more slowly, or a datacentre — and shipping the sanitized
context to someone else's inference service keeps "the screen never leaves the device"
literally true while handing away what the user was actually protecting.

**"Isn't 900 MB of memory a lot?"** Yes, and it is the weakest number in the project. About
300–400 MB is the vision pipeline; the rest is five real pages in one browser. Three
reductions are identified and none is done: a WASM-only ONNX build (27 MB of runtime), a
pre-scaled 640×640 detector input instead of a full-viewport screenshot, and releasing the
OCR worker when idle.

**"How do we know these numbers aren't cherry-picked?"** Every one is produced by a named
command over a versioned dataset committed to the repository, and `results.md` opens by
saying what is wrong with the dataset before it shows a figure. The most important
disclosure is that the detectors were _tuned against_ this dataset after it exposed five
defects, so these are not held-out numbers — a held-out set is the first item of the next
stage.

**"Why rules instead of an NER model, when the spec asked for a model?"** Costed, not
dodged: the smallest credible ONNX NER export is 94–109 MB quantised, against a 40 MB
package and a 20% resource-utilisation rubric line already reporting +907 MB. The rules
score 100% recall and 69.8% precision; the model would improve the second number and worsen
the fourth criterion. The decision is recorded at Phase 3.2 in the build spec, and the code
comment in `unstructuredPii.ts` states it too.

**"What is the biggest thing you would do next?"** A held-out dataset, then the DOM half of
the client — it is now the larger latency cost on real pages, which is the opposite of what
the early fixtures suggested.
