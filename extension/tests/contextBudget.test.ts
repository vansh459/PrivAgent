import { beforeEach, describe, expect, it } from "vitest";
import { perceiveDom } from "../src/content/domWalker";
import { prepareContext } from "../src/content/pipeline";
import { detectStructuredPii } from "../src/content/privacy";
import { stubLayout } from "./helpers/layout";

/**
 * Build Spec Phase 4.3 and 4.4 acceptance criteria, as executable tests: the transmitted
 * payload must be at least 70% smaller than a raw DOM dump across five site types, and
 * no serialized payload may contain a raw PII value.
 *
 * Size is the proxy for the minimum-required-context principle. A payload that is a large
 * fraction of the page has not filtered anything, whatever the code claims.
 */

/**
 * Fixtures carry the markup overhead a real page has - wrapper divs, class names, data
 * attributes, an inline script, an SVG icon. Measuring against hand-minified HTML would
 * measure how tersely the fixture was written, not how much the Context Builder strips.
 *
 * These are still synthetic. The authoritative measurement is Stage 3, against the
 * labelled real-screen dataset.
 */
function page(main: string): string {
  return `
    <div class="app-shell" data-app="privagent-fixture" data-theme="light">
      <header class="site-header site-header--compact" role="banner">
        <svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 2 22h20z" /></svg>
        <span class="site-header__title">Department of Space</span>
      </header>
      <div class="layout layout--two-column">
        <main class="layout__main content-region" id="main-content" tabindex="-1">
          ${main}
        </main>
        <aside class="layout__aside" aria-label="Related">
          <div class="card card--muted"><p class="card__body">Related guidance and circulars.</p></div>
        </aside>
      </div>
      <footer class="site-footer"><p class="site-footer__text">Government of India</p></footer>
      <script type="application/json" id="app-state">{"locale":"en-IN","build":"4.12.9"}</script>
    </div>`;
}

const PAGES: ReadonlyArray<readonly [string, string, string]> = [
  [
    "form",
    "submit application",
    page(`<h1 class="page-title">Grant Application</h1>
     <p class="lede">Queries: 9876543210 or grants@example.org. PAN ABCDE1234F on record.</p>
     <form class="form form--stacked" novalidate>
       <div class="field"><label for="name">Applicant name</label><input id="name" name="name" class="input" /></div>
       <div class="field"><label for="aadhaar">Aadhaar</label><input id="aadhaar" name="aadhaar" class="input" value="1234 5678 9012" /></div>
       <div class="field"><label for="pw">Password</label><input id="pw" type="password" name="password" class="input" /></div>
       <div class="field"><textarea id="notes" class="input input--area" placeholder="Notes"></textarea></div>
       <div class="actions"><button id="submit" class="btn btn--primary">Submit application</button>
       <button id="reset" type="reset" class="btn btn--ghost">Reset</button></div>
     </form>`),
  ],
  [
    "dashboard",
    "refresh the panel",
    page(`<nav class="tabs" aria-label="Sections"><a href="/home" class="tabs__link">Home</a>
       <a href="/reports" class="tabs__link">Reports</a><a href="/settings" class="tabs__link">Settings</a></nav>
     <section class="panel panel--telemetry"><h2 class="panel__title">Mission Telemetry</h2>
       <p class="panel__meta">Operator: ops@example.gov.in, desk 9812345678</p>
       <div class="panel__actions"><button id="refresh" class="btn">Refresh</button>
       <button id="export" class="btn btn--ghost">Export CSV</button>
       <select id="range" class="select"><option>Daily</option><option>Monthly</option></select></div>
     </section>
     <div class="notice notice--info"><p>Last sync 2026-09-04. Build 4.12.9. Node 7 of 12 healthy.</p></div>`),
  ],
  [
    "portal",
    "download report",
    page(`<h1 class="page-title">Expenditure Portal</h1>
     <p class="lede">Sanctioned expenditure for the quarter. Helpline 7654321098.</p>
     <ul class="link-list"><li class="link-list__item"><a id="dl" href="/report.pdf" class="link">Download report</a></li>
       <li class="link-list__item"><a id="archive" href="/archive" class="link">Archive</a></li></ul>
     <div class="actions"><button id="print" class="btn">Print</button></div>
     <div class="card"><p class="card__body">Card on file 4111 1111 1111 1111 for reimbursements.</p></div>`),
  ],
  [
    "e-commerce",
    "add to cart",
    page(`<article class="product"><h1 class="product__title">Component X</h1>
      <p class="product__meta">Rated 4.6 from 1,204 reviews. Ships in 3 days.</p>
      <div class="product__actions"><button id="cart" class="btn btn--primary">Add to cart</button>
      <button id="wish" class="btn btn--ghost">Save for later</button></div>
      <a href="/details" class="link">Product details</a>
      <div class="field"><input id="coupon" class="input" placeholder="Coupon code" /></div>
      <p class="product__support">Support: shop@example.com or 9123456780.</p>
     </article>
     <section class="recommendations"><p>Customers also viewed a long list of unrelated products.</p></section>`),
  ],
  [
    "single-page application",
    "save changes",
    page(`<div role="menuitem" aria-label="Open navigation" class="icon-button"></div>
     <div role="tablist" class="tabs"><div role="tab" aria-label="General" class="tabs__tab">General</div>
       <div role="tab" aria-label="Security" class="tabs__tab">Security</div></div>
     <div class="editor"><textarea id="comment" class="input input--area" placeholder="Comment"></textarea></div>
     <div class="actions"><button id="save" class="btn btn--primary">Save changes</button>
       <button id="cancel" class="btn btn--ghost">Cancel</button></div>
     <p class="editor__meta">Session owner dev@example.io, OTP is 246810 for confirmation.</p>
     <p class="editor__meta">Autosaved 30 seconds ago. Draft revision 18. Collaborators online: 3.</p>`),
  ],
];

describe("Phase 4.3 - transmitted payload budget", () => {
  beforeEach(() => stubLayout());

  it.each(PAGES)("reduces the %s payload by at least 70%%", (_siteType, task, html) => {
    document.body.innerHTML = html;

    const rawDump = document.body.outerHTML;
    const { context } = prepareContext(task, perceiveDom().elements);
    const payload = JSON.stringify(context);

    const reduction = 1 - payload.length / rawDump.length;
    expect(
      reduction,
      `payload ${payload.length}B vs raw DOM ${rawDump.length}B`,
    ).toBeGreaterThanOrEqual(0.7);
  });

  it("excludes unrelated fields from a single-step task", () => {
    document.body.innerHTML = `
      <a id="dl" href="/r.pdf">Download report</a>
      <input id="coupon" placeholder="Coupon code" />
      <p>Unrelated marketing copy about our newsletter</p>`;

    const { context } = prepareContext("download report", perceiveDom().elements);

    expect(context.elements.map((element) => element.text)).not.toContain(
      "Unrelated marketing copy about our newsletter",
    );
  });
});

describe("Phase 4.4 - no raw PII in any serialized payload", () => {
  beforeEach(() => stubLayout());

  const secrets = [
    "9876543210",
    "grants@example.org",
    "ABCDE1234F",
    "1234 5678 9012",
    "4111 1111 1111 1111",
    "ops@example.gov.in",
    "9812345678",
    "7654321098",
    "shop@example.com",
    "9123456780",
    "dev@example.io",
    "246810",
  ];

  it.each(PAGES)("emits no raw value for the %s page", (_siteType, task, html) => {
    document.body.innerHTML = html;

    const payload = JSON.stringify(prepareContext(task, perceiveDom().elements).context);

    for (const secret of secrets) {
      expect(payload, `payload leaked ${secret}`).not.toContain(secret);
    }
    expect(detectStructuredPii(payload)).toEqual([]);
  });

  it("runs every page against every task without leaking, for 25 payloads in total", () => {
    const leaks: string[] = [];

    for (const [siteType, , html] of PAGES) {
      for (const [, task] of PAGES) {
        document.body.innerHTML = html;
        const payload = JSON.stringify(prepareContext(task, perceiveDom().elements).context);
        if (detectStructuredPii(payload).length > 0) leaks.push(`${siteType} / ${task}`);
      }
    }

    expect(leaks).toEqual([]);
  });
});
