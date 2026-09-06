/**
 * Captures the Phase 8.1 evaluation dataset: real public web pages, frozen as inert,
 * self-contained local snapshots.
 *
 *   node scripts/capture-dataset.mjs [--only id,id] [--limit N]
 *
 * Why real pages rather than pages we wrote: a benchmark built entirely from fixtures the
 * authors also designed measures how well the system handles the authors' idea of a web
 * page. Real portals have nested navigation, duplicated links, icon-only buttons, sticky
 * headers, consent banners and markup nobody would write on purpose, and those are exactly
 * the cases a DOM walker and a Set-of-Mark tagger get wrong.
 *
 * Why frozen rather than fetched at evaluation time: a number that changes when a third
 * party redesigns their homepage cannot be compared across runs, and an evaluation that
 * needs the internet is an evaluation that fails in a hall with bad wifi. Every snapshot is
 * made self-contained at capture time and served from `127.0.0.1` afterwards, with all
 * outbound requests blocked during evaluation - which also means the dataset cannot phone
 * home while measuring a privacy tool.
 *
 * What "inert" means here, precisely:
 *   - every `<script>`, `<iframe>`, `<noscript>` and preload/prefetch hint is removed, so a
 *     snapshot is markup and style only and cannot execute anything at evaluation time;
 *   - stylesheets are fetched once and inlined, so layout survives offline;
 *   - images are inlined as data URIs where the site allows it, and replaced by a
 *     same-sized grey placeholder where it does not, so no request is ever made off-box;
 *   - `url(...)` references inside CSS are neutralised for the same reason.
 *
 * The pages are captured for non-commercial academic evaluation of this project, with
 * provenance for every one recorded in `sources.json`. The snapshots are committed to a
 * public repository - so they are redistributed, and `tests/dataset/README.md` says so
 * plainly rather than calling it something softer. No page is captured behind a login, a
 * paywall or a consent gate, and any page can be dropped from `sites.json` on request.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Playwright is a dev dependency of the extension workspace, not of the root. Resolving it
// from there keeps the browser toolchain in one place rather than installed twice.
const { chromium } = createRequire(join(repoRoot, "extension", "package.json"))(
  "playwright",
);
const datasetDir = join(repoRoot, "tests", "dataset", "screens");

const VIEWPORT = { width: 1280, height: 900 };
const NAVIGATION_TIMEOUT_MS = 60_000;
/** SPAs render after load; this is how long they get to finish before the page is frozen. */
const SETTLE_MS = 3_000;

/** A 1x1 transparent GIF, used to neutralise every CSS `url(...)` without moving layout. */
const BLANK =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * Finds a Chromium to drive.
 *
 * Playwright's own download is preferred, but this machine carries two partially-installed
 * revisions, so the directory is checked for the completion marker rather than trusting
 * `executablePath()` - which points at whichever revision the library expects, installed or
 * not. Edge is the documented fallback, the same one `e2e/harness.ts` uses.
 */
function browserOptions() {
  const root = join(homedir(), "AppData", "Local", "ms-playwright");
  if (existsSync(root)) {
    const builds = readdirSync(root)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((left, right) => Number(right.slice(9)) - Number(left.slice(9)));
    for (const build of builds) {
      if (!existsSync(join(root, build, "INSTALLATION_COMPLETE"))) continue;
      for (const folder of ["chrome-win64", "chrome-win"]) {
        const executable = join(root, build, folder, "chrome.exe");
        if (existsSync(executable)) return { executablePath: executable };
      }
    }
  }
  return { channel: "msedge" };
}

function argument(name) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Runs inside the page: fetches every subresource the snapshot needs, inlines it, and
 * strips everything that could execute or reach the network later.
 *
 * This has to run in the page rather than in Node because subresources are fetched with
 * the page's own origin, cookies and referrer - a Node-side fetch of the same URL is a
 * different request, and many sites answer it differently or not at all.
 */
async function freeze(blank) {
  const asDataUri = async (url) => {
    try {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) return undefined;
      const blob = await response.blob();
      // 50 KB. Logos, icons and small graphics - the ones that carry text worth reading -
      // are kept; hero images and photography are not. Inlining everything produced 2.5 MB
      // snapshots, and a hundred megabytes of other people's JPEGs is not a test fixture.
      if (blob.size > 50_000) return undefined;
      return await new Promise((done) => {
        const reader = new FileReader();
        reader.onload = () => done(String(reader.result));
        reader.onerror = () => done(undefined);
        reader.readAsDataURL(blob);
      });
    } catch {
      return undefined;
    }
  };

  const notes = {
    stylesheets: 0,
    stylesheetsFailed: 0,
    images: 0,
    imagesPlaceheld: 0,
  };

  // Stylesheets first: everything else measures the layout they produce.
  for (const link of [
    ...document.querySelectorAll('link[rel~="stylesheet"]'),
  ]) {
    const href = link.href;
    let text;
    try {
      const response = await fetch(href, { credentials: "include" });
      text = response.ok ? await response.text() : undefined;
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      // Some cross-origin sheets refuse a fetch but are readable through the CSSOM,
      // because the browser already loaded them under the tag's own relaxed rules.
      try {
        const sheet = [...document.styleSheets].find(
          (candidate) => candidate.href === href,
        );
        text = [...(sheet?.cssRules ?? [])]
          .map((rule) => rule.cssText)
          .join("\n");
      } catch {
        text = undefined;
      }
    }
    if (!text) {
      notes.stylesheetsFailed += 1;
      link.remove();
      continue;
    }
    const style = document.createElement("style");
    // Absolute-then-neutralise: relative `url()`s would resolve against 127.0.0.1 at
    // evaluation time and 404 noisily; a blank pixel keeps the box and makes no request.
    style.textContent = text.replace(
      /url\(\s*(['"]?)(?!data:)[^)'"]*\1\s*\)/gi,
      `url(${blank})`,
    );
    if (link.media && link.media !== "all") style.media = link.media;
    link.replaceWith(style);
    notes.stylesheets += 1;
  }

  for (const style of [...document.querySelectorAll("style")]) {
    style.textContent = (style.textContent ?? "").replace(
      /url\(\s*(['"]?)(?!data:)[^)'"]*\1\s*\)/gi,
      `url(${blank})`,
    );
  }

  for (const image of [...document.querySelectorAll("img")]) {
    const rect = image.getBoundingClientRect();
    image.removeAttribute("srcset");
    image.removeAttribute("loading");
    for (const attribute of [...image.attributes]) {
      if (attribute.name.startsWith("data-"))
        image.removeAttribute(attribute.name);
    }
    const source = image.currentSrc || image.src;
    const inlined =
      source && !source.startsWith("data:") ? await asDataUri(source) : source;
    if (inlined) {
      image.src = inlined;
      notes.images += 1;
    } else {
      // Same box, no request: the layout the page produced is preserved even though the
      // picture is not. Nothing in the ground truth depends on a site's own imagery -
      // the faces and canvases the vision pipeline is scored on are composited in later.
      const width = Math.max(1, Math.round(rect.width) || image.width || 1);
      const height = Math.max(1, Math.round(rect.height) || image.height || 1);
      image.src =
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
            `<rect width="100%" height="100%" fill="#d8d8d8"/></svg>`,
        );
      image.style.width = `${width}px`;
      image.style.height = `${height}px`;
      notes.imagesPlaceheld += 1;
    }
  }

  for (const node of [
    ...document.querySelectorAll(
      'script, noscript, iframe, object, embed, base, link[rel~="preload"], ' +
        'link[rel~="prefetch"], link[rel~="dns-prefetch"], link[rel~="preconnect"], ' +
        'link[rel~="modulepreload"], meta[http-equiv]',
    ),
  ]) {
    node.remove();
  }

  for (const source of [
    ...document.querySelectorAll("source, track, video, audio"),
  ]) {
    source.remove();
  }

  document.documentElement.setAttribute(
    "data-privagent-snapshot",
    location.href,
  );
  return notes;
}

async function capture(browser, site) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    // A real desktop UA. Announcing a headless browser to a portal that then serves a
    // stripped page would produce a snapshot of something no user ever sees.
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);

  try {
    const response = await page.goto(site.url, {
      waitUntil: "load",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await page.waitForTimeout(SETTLE_MS);
    await page
      .waitForLoadState("networkidle", { timeout: 15_000 })
      .catch(() => undefined);
    await page.evaluate(() => window.scrollTo(0, 0));

    const notes = await page.evaluate(freeze, BLANK);
    const html = await page.evaluate(
      () => "<!doctype html>\n" + document.documentElement.outerHTML,
    );
    const title = await page.title();
    const finalUrl = page.url();
    const interactive = await page.evaluate(
      () =>
        document.querySelectorAll(
          "a[href], button, input, select, textarea, [role], [contenteditable='true']," +
            " [tabindex]:not([tabindex='-1'])",
        ).length,
    );

    // Gzipped: these are markup, and markup compresses about eight to one. The dataset
    // has to live in the repository to be versioned at all, and it has to be small enough
    // that someone will actually clone it.
    const packed = gzipSync(Buffer.from(html, "utf8"), { level: 9 });
    writeFileSync(join(datasetDir, `${site.id}.html.gz`), packed);
    await page.screenshot({
      path: join(datasetDir, `${site.id}.jpg`),
      type: "jpeg",
      quality: 78,
      fullPage: false,
    });

    return {
      id: site.id,
      type: site.type,
      url: site.url,
      finalUrl,
      title,
      status: response?.status() ?? null,
      capturedAt: new Date().toISOString(),
      bytes: Buffer.byteLength(html, "utf8"),
      packedBytes: packed.byteLength,
      interactiveNodes: interactive,
      ...notes,
      ok: true,
    };
  } catch (error) {
    // Recorded, never quietly substituted: a reader of the dataset is entitled to know
    // which pages refused to be captured and why.
    return {
      id: site.id,
      type: site.type,
      url: site.url,
      capturedAt: new Date().toISOString(),
      ok: false,
      failure: String(error).split("\n")[0].slice(0, 200),
    };
  } finally {
    await context.close();
  }
}

async function main() {
  mkdirSync(datasetDir, { recursive: true });
  const { sites } = JSON.parse(
    readFileSync(join(repoRoot, "tests", "dataset", "sites.json"), "utf8"),
  );

  const only = argument("only")?.split(",");
  const limit = Number(argument("limit") ?? sites.length);
  const wanted = sites
    .filter((site) => !only || only.includes(site.id))
    .slice(0, limit);

  const browser = await chromium.launch(browserOptions());
  const records = [];
  for (const [index, site] of wanted.entries()) {
    process.stdout.write(`[${index + 1}/${wanted.length}] ${site.id} ... `);
    const record = await capture(browser, site);
    records.push(record);
    console.log(
      record.ok
        ? `ok, ${record.interactiveNodes} interactive nodes, ${Math.round(record.bytes / 1024)} KB`
        : `FAILED: ${record.failure}`,
    );
  }
  await browser.close();

  const captured = records.filter((record) => record.ok);
  writeFileSync(
    join(datasetDir, "sources.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        viewport: VIEWPORT,
        captured: captured.length,
        attempted: records.length,
        licence:
          "Third-party pages captured for non-commercial academic evaluation of PrivAgent. " +
          "Public, logged-out pages only. Snapshots are inert - no scripts, no frames, no outbound requests - and are committed to a public repository so the evaluation can be reproduced; any page can be removed on request. See tests/dataset/README.md.",
        records,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(
    `\nCaptured ${captured.length} of ${records.length} pages into ${datasetDir}`,
  );
  if (captured.length < 30) {
    console.error("Fewer than the 30 screens Phase 8.1 requires.");
    process.exitCode = 1;
  }
}

await main();
