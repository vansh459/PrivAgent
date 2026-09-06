# PrivAgent design system

Version 1.0 · 2026-09-06 · every value defined once in
[`extension/src/ui/tokens.css`](../extension/src/ui/tokens.css)

Before this pass, the interface had accumulated rather than been designed: five type sizes,
pixel values from 2 to 18 invented per property, a colour picked per declaration, and an
in-page prompt carrying an entirely separate light-only stylesheet that shared nothing with
the popup. It also had three real defects nobody had noticed — the diagnostics page set a
`wide` class that did not exist, so an options page rendered at 340px with URLs running off
the edge; its pass/fail colouring targeted an element the stylesheet never matched, so it
did nothing at all; and two mojibake characters were shipping in the HTML.

There is now one system, and every rule below is enforceable: if a component's styling
cannot be traced to one of these, it is a bug.

## The rules

1. **One font family.** Inter, vendored locally.
2. **Two type sizes.** 13px body/UI and 16px headings. Hierarchy comes from weight, colour
   and letter-spacing — never from a third size.
3. **One spacing scale.** 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64. Nothing invents a value.
4. **One neutral ramp, one accent ramp, one semantic set.** Nothing else.
5. **Glass floats. Clay is primary. Everything else is flat.**

## Tokens

| Group  | Tokens                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------- |
| Type   | `--font-sans`, `--text-body`, `--text-heading`, `--leading-*`, `--weight-*`, `--tracking-*`, `--measure`        |
| Space  | `--space-1…16`, `--radius-sm/md/lg`, `--border-width`, `--rule-width`                                           |
| Size   | `--width-popup`, `--width-page`, `--width-prompt`, `--control-height`                                           |
| Colour | `--neutral-0…900`, `--accent-100/500/600/fg`, `--success`, `--warning`, `--danger` (+ tints)                    |
| Roles  | `--canvas`, `--surface`, `--surface-sunken`, `--border`, `--border-strong`, `--fg`, `--fg-muted`, `--fg-subtle` |
| Glass  | `--glass-bg`, `--glass-border`, `--glass-blur`, `--glass-saturate`, `--glass-shadow`                            |
| Clay   | `--clay-shadow`, `--clay-shadow-hover`, `--clay-shadow-pressed`                                                 |
| Focus  | `--ring`, `--ring-inset`                                                                                        |
| Motion | `--ease`, `--duration-fast`, `--duration`                                                                       |

Components reference the **role** tokens, never the ramps. That is what lets the dark theme
redefine values without a single component rule being restated.

## One file, two worlds

The token file is imported by `popup.css` for the extension's own pages, and inlined into
the closed shadow root of the in-page confirmation prompt by `content/confirm.ts` via
Vite's `?inline`. That surface runs on a third-party origin and inherits nothing, so it has
to carry its own copy of the stylesheet — but it carries _the same file_, so there is no
second set of values to drift. Two rewrites happen on the way in, both forced by the
boundary: `:root` becomes `:host`, because the document element is outside that tree; and
the `@font-face` rule is stripped, because shadow DOM ignores it — the face is registered
on the document through the `FontFace` API instead.

## Where glass is, where clay is, and why

**Glass is on three surfaces, and all three genuinely float above content:** the popup's
sticky header, the diagnostics page's sticky header, and the in-page confirmation prompt.
Blur is what makes layering legible, and layering is the only thing it is for here — no
card, no panel and no body-text container gets it, because translucency behind reading
material buys nothing and costs contrast. **Clay is on exactly one control per screen:** the
popup's _Run task_, the diagnostics page's _Run probe_, and the prompt's _Allow_. Those are
the actions each screen exists to offer, and they are tactile so that they invite a press;
_Save_, _Run OCR self-test_ and _Deny_ sit beside them deliberately flat, because if the
secondary action were also raised, neither would mean anything. The light source is at
top-left in every clay shadow in the product, so nothing looks lit from a different room.
Everything else — inputs, cards, the summary grid, the audit trail, status lines — is flat,
and the restraint is the point: with two treatments reserved this narrowly, seeing one tells
you something.

## Contrast is computed, not eyeballed

[`extension/tests/contrast.test.ts`](../extension/tests/contrast.test.ts) parses the token
file, resolves the `var()` chains, and asserts WCAG AA (4.5:1) for every text/surface pair
in both colour schemes — 36 checks. Translucent surfaces are checked the hard way: the glass
fill is composited onto **pure white and pure black**, the extremes the in-page prompt can
land on, since its backdrop is a page nobody has seen.

That test found five real failures on the first run and they were fixed in the tokens rather
than waived: `--fg-subtle` was at 2.95:1 on a card, the light warning and danger colours
failed over glass on a dark page, and dark-mode muted text failed over glass on a bright
one. The dark glass fill sits at 0.90 alpha rather than 0.82 for exactly that reason — a
dark card over a bright page loses contrast faster than the reverse. **A failure there is a
design bug, and the fix is the token, not the threshold.**

## The font

Inter, latin subset, 48 KB, committed at `extension/assets/fonts/Inter-latin.woff2` under
the SIL OFL 1.1 and pinned by SHA-256 in `scripts/vendor-assets.mjs` beside the ONNX model.
It is not loaded from a CDN, for the same reason nothing else in this extension is: the
fetch itself would tell a third party when and where the agent started. `fonts/*` is
web-accessible so the in-page prompt can use the same face, and the diagnostics page lists
it alongside the models — where `vision.spec.ts` already asserts that no request leaves the
extension's own origin.

## Motion

One easing curve, two durations (150ms for controls, 200ms for state), and a
`prefers-reduced-motion` block in the token file that zeroes both for the whole product at
once. Hover, `:active` and `:focus-visible` are defined once on the shared button and field
rules rather than per component.

## What is deliberately not covered

`src/ui/offscreen.html` has no styles and gets none: it is never rendered, and exists only
to give local vision an extension-origin document to run in.

## The two literals that are not tokens

`blur(1px)` inside `@supports` is a feature probe, not a design value. `max-width: 640px` is
the diagnostics breakpoint, and it has to be a literal because **a media query cannot read a
custom property** — that is a CSS limitation, and it is commented where it appears rather
than left to look like an oversight.

## Before and after

Screenshots of every surface in both colour schemes are in [`ui/before/`](./ui/before) and
[`ui/after/`](./ui/after), captured by the same command:

```bash
PRIVAGENT_UI_SHOTS=after npx playwright test e2e/screenshots.spec.ts
```
