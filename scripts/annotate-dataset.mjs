/**
 * Turns the captured snapshots into a labelled dataset: injects synthetic PII and visual
 * content, then records the ground truth for every screen.
 *
 *   node scripts/annotate-dataset.mjs [--only id,id]
 *
 * Two things have to be said plainly about how this dataset is labelled, because they are
 * the difference between a number and a claim.
 *
 * **The PII is injected, and it is synthetic.** A logged-out public page contains no
 * personal data, so a dataset made only of captures would have nothing to detect. Using a
 * real person's Aadhaar number or card would be indefensible whatever the licence says.
 * So the pages are real and the people in them are not: twelve synthetic personas from
 * `personas.json` are written into real elements of real pages, in formats chosen to
 * include the ones a regex is likely to miss as well as the ones it was written for. The
 * annotation is then exact by construction - the label is the string that was inserted,
 * not somebody's later reading of the page.
 *
 * **The element ground truth comes from an independent oracle.** It is Chrome's own
 * accessibility tree, read over CDP (`Accessibility.getFullAXTree`) with boxes from
 * `DOM.getBoxModel`, filtered to the roles a user can act on. That is a different
 * computation from this project's DOM walker, written by different people for a different
 * purpose, which is what makes agreement with it meaningful. It is *not* independent of
 * the DOM: both read the same document. It cannot tell you whether the page's markup
 * describes what is painted, only whether PrivAgent sees what Chrome's accessibility layer
 * sees. The parts of perception that no DOM oracle can score - text that exists only as
 * pixels, and faces - are covered by the composited regions instead, where the truth is
 * the string that was drawn and the rectangle it was drawn into.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(join(repoRoot, "extension", "package.json"));
const { chromium } = require_("playwright");

const datasetDir = join(repoRoot, "tests", "dataset", "screens");
const facesDir = join(repoRoot, "tests", "dataset", "faces");

// 1 280 x 720: the viewport the browser suite actually runs at, and a common laptop size.
// Ground-truth boxes are only comparable to what the extension reports if both are measured
// in the same layout, and Playwright's persistent context - the one that can load an
// unpacked extension - uses this viewport. Annotating at any other height put every box on
// a page with a full-height hero in the wrong place.
const VIEWPORT = { width: 1280, height: 720 };

/** Accessible roles a user can act on. The oracle is filtered to these. */
const ACTIONABLE_AX_ROLES = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
]);

const FACE_FILES = ["armstrong", "bluford", "chawla", "jemison", "ride"];

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

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

/** A small deterministic PRNG, so re-running the annotator reproduces the same dataset. */
function seeded(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function hash(text) {
  let value = 2166136261;
  for (const character of text) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/**
 * Serves the gunzipped snapshots over HTTP.
 *
 * Over HTTP rather than from a file, and re-served identically at evaluation time, because
 * layout - and therefore every bounding box in the ground truth - depends on the origin the
 * document believes it has.
 */
function startDatasetServer() {
  const server = createServer((request, response) => {
    const id = (request.url ?? "/").replace(/^\/+/, "").split("?")[0];
    const file = join(datasetDir, `${id}.html.gz`);
    if (!existsSync(file)) {
      response.writeHead(404).end("no such screen");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(gunzipSync(readFileSync(file)));
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () =>
      done({ server, port: server.address().port }),
    );
  });
}

/**
 * Runs in the page: removes any previous annotation, then injects this run's.
 *
 * Idempotent on purpose - the annotator is re-run whenever the labelling changes, and a
 * pass that appended to the last one would silently double the ground truth.
 */
function annotate({ spans, faceImage, viewport }) {
  const previous = document.querySelectorAll("[data-privagent-truth]");
  for (const node of previous) {
    const original = node.getAttribute("data-privagent-original");
    if (original !== null) {
      node.textContent = original;
      const label = node.getAttribute("data-privagent-original-label");
      if (label !== null) {
        node.setAttribute("aria-label", label);
        node.removeAttribute("data-privagent-original-label");
      }
      node.removeAttribute("data-privagent-original");
      node.removeAttribute("data-privagent-truth");
    } else {
      node.remove();
    }
  }

  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  };

  // Candidates for the "appended to a real element" half of the injection: genuine links
  // and buttons of this page, with their own text, which a portal really would carry a
  // helpline number or a reference on.
  const anchors = [...document.querySelectorAll("a[href], button")].filter(
    (element) =>
      visible(element) &&
      (element.textContent ?? "").trim().length >= 4 &&
      (element.textContent ?? "").trim().length <= 60 &&
      element.children.length === 0,
  );

  // Hosts for the "inserted panel" half: real containers, so the panel inherits the site's
  // own typography and sits inside its layout rather than floating over it.
  const hosts = [
    ...document.querySelectorAll("main, article, section, form, div"),
  ].filter((element) => {
    const rect = element.getBoundingClientRect();
    return (
      rect.width >= 320 && rect.height >= 60 && rect.top >= 0 && rect.top < 2400
    );
  });

  const placed = [];

  for (const span of spans) {
    if (span.mode === "append" && anchors.length > 0) {
      const element = anchors[span.slot % anchors.length];
      if (element.hasAttribute("data-privagent-truth")) continue;
      element.setAttribute(
        "data-privagent-original",
        element.textContent ?? "",
      );
      element.setAttribute("data-privagent-truth", span.id);
      element.textContent = `${(element.textContent ?? "").trim()} ${span.text}`;
      // An `aria-label` overrides visible text as an element's accessible name, and both
      // this project's DOM walker and a screen reader use the accessible name. Real pages
      // - HDFC's footer, the income-tax portal's navigation - label their links, so
      // appending to the text alone produced elements that displayed an email address and
      // were still *named* "Customer Services". Keeping the label in step is what a
      // correctly-built page does. That the mismatch hides PII from a DOM walker entirely
      // is a real finding in its own right, and is recorded in docs/RESULTS.md rather than
      // engineered into the dataset.
      if (element.hasAttribute("aria-label")) {
        element.setAttribute(
          "data-privagent-original-label",
          element.getAttribute("aria-label") ?? "",
        );
        element.setAttribute(
          "aria-label",
          `${element.getAttribute("aria-label")?.trim() ?? ""} ${span.text}`.trim(),
        );
      }
      placed.push(span.id);
    } else {
      const host =
        hosts.length > 0 ? hosts[span.slot % hosts.length] : document.body;
      const panel = document.createElement("div");
      panel.setAttribute("role", span.role);
      panel.setAttribute("tabindex", "0");
      panel.setAttribute("data-privagent-truth", span.id);
      panel.style.cssText =
        "padding:6px 10px;margin:6px 0;border:1px solid #d8d8d8;border-radius:4px;" +
        "font:13px/1.5 system-ui,sans-serif;color:#222;background:#fbfbfb";
      panel.textContent = span.text;
      host.prepend(panel);
      placed.push(span.id);
    }
  }

  /** Draws text into a canvas and freezes it as an image, so the snapshot needs no script. */
  const painted = (id, text, width, height, top) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#111111";
    context.font = "20px Arial";
    context.fillText(text, 14, height / 2 + 7);
    const image = document.createElement("img");
    image.src = canvas.toDataURL("image/png");
    image.setAttribute("data-privagent-truth", id);
    image.style.cssText =
      `position:fixed;right:16px;top:${top}px;width:${width}px;height:${height}px;` +
      "z-index:2147483000;border:1px solid #bbb;background:#fff";
    document.body.append(image);
    return image.getBoundingClientRect();
  };

  const face = document.createElement("img");
  face.src = faceImage;
  face.setAttribute("data-privagent-truth", "face_1");
  face.style.cssText =
    "position:fixed;right:16px;top:16px;width:130px;height:160px;z-index:2147483000;" +
    "border:1px solid #bbb;background:#fff";
  document.body.append(face);
  const faceRect = face.getBoundingClientRect();

  const textRect = painted("vis_text_1", "Balance due 12,480.00", 320, 70, 190);
  const piiRect = painted(
    "vis_pii_1",
    spans.find((span) => span.pixelText)?.pixelText ?? "",
    320,
    70,
    274,
  );

  const box = (rect) => [
    Math.round(rect.left),
    Math.round(rect.top),
    Math.round(rect.width),
    Math.round(rect.height),
  ];

  const truthBoxes = {};
  for (const node of document.querySelectorAll("[data-privagent-truth]")) {
    truthBoxes[node.getAttribute("data-privagent-truth")] = box(
      node.getBoundingClientRect(),
    );
  }

  // The exact strings the Privacy Firewall will be handed, captured here so the PII
  // evaluation can run offline against real page text rather than re-rendering 42 pages.
  // The extraction mirrors `domWalker.elementText`: a control is described by its label,
  // never by its value.
  const texts = [];
  const interactive = document.querySelectorAll(
    "a[href], button, input, select, textarea, [role], [contenteditable='true']," +
      " [tabindex]:not([tabindex='-1'])",
  );
  for (const element of interactive) {
    if (!visible(element)) continue;
    const isField =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement;
    const label = element.labels?.[0] ?? element.closest("label");
    const text = (
      element.getAttribute("aria-label")?.trim() ||
      (isField
        ? label?.textContent?.trim() ||
          element.placeholder ||
          element.name ||
          ""
        : element.innerText?.trim() || element.textContent?.trim() || "")
    ).replace(/\s+/g, " ");
    if (!text) continue;
    texts.push({
      text,
      truthId:
        element
          .closest("[data-privagent-truth]")
          ?.getAttribute("data-privagent-truth") ?? null,
    });
  }

  return {
    placed,
    truthBoxes,
    texts,
    faceBox: box(faceRect),
    textBox: box(textRect),
    piiBox: box(piiRect),
    documentHeight: document.documentElement.scrollHeight,
    viewport,
    html: "<!doctype html>\n" + document.documentElement.outerHTML,
  };
}

/** Chrome's accessibility tree, filtered to actionable roles, with boxes. */
async function oracle(page) {
  const session = await page.context().newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("Accessibility.enable");
  const { nodes } = await session.send("Accessibility.getFullAXTree");

  const elements = [];
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value;
    if (!role || !ACTIONABLE_AX_ROLES.has(role)) continue;
    if (!node.backendDOMNodeId) continue;
    let model;
    try {
      model = await session.send("DOM.getBoxModel", {
        backendNodeId: node.backendDOMNodeId,
      });
    } catch {
      continue; // Not rendered: no box, so nothing a user could act on.
    }
    const quad = model.model.border;
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const bbox = [
      Math.round(Math.min(...xs)),
      Math.round(Math.min(...ys)),
      Math.round(Math.max(...xs) - Math.min(...xs)),
      Math.round(Math.max(...ys) - Math.min(...ys)),
    ];
    if (bbox[2] <= 0 || bbox[3] <= 0) continue;
    elements.push({
      oracleId: `ax_${elements.length + 1}`,
      role,
      name: (node.name?.value ?? "").replace(/\s+/g, " ").trim(),
      bbox,
    });
  }
  await session.detach();
  return elements;
}

/** The ten PII spans for one page, drawn deterministically from one persona. */
function spansFor(id, persona, random) {
  const templates = [
    {
      type: "PHONE",
      value: persona.phone,
      text: `Helpline ${persona.phone}`,
      mode: "append",
    },
    {
      type: "PHONE",
      value: persona.phoneAlt,
      text: `Alternate contact ${persona.phoneAlt}`,
      role: "status",
      mode: "panel",
    },
    {
      type: "EMAIL",
      value: persona.email,
      text: `Write to ${persona.email}`,
      mode: "append",
    },
    {
      type: "AADHAAR",
      value: persona.aadhaar,
      text: `Aadhaar ${persona.aadhaar} linked to this account`,
      role: "note",
      mode: "panel",
    },
    {
      type: "PAN",
      value: persona.pan,
      text: `PAN ${persona.pan}`,
      mode: "append",
    },
    {
      type: "CARD",
      value: persona.card,
      text: `Card on file ${persona.card}`,
      role: "note",
      mode: "panel",
    },
    {
      type: "OTP",
      value: persona.otp,
      text: `${persona.otp} sent to your phone`,
      role: "status",
      mode: "panel",
    },
    {
      type: "NAME",
      value: persona.name,
      text: `Signed in as ${persona.name}`,
      role: "status",
      mode: "panel",
    },
    {
      type: "ADDRESS",
      value: persona.address,
      text: `Registered address ${persona.address}`,
      role: "note",
      mode: "panel",
    },
    {
      type: "EMAIL",
      value: persona.email,
      text: `Grievance cell ${persona.email}`,
      mode: "append",
    },
  ];

  return templates.map((template, index) => ({
    id: `pii_${index + 1}`,
    slot: Math.floor(random() * 97),
    role: template.role ?? "note",
    ...template,
  }));
}

async function main() {
  const only = argument("only")?.split(",");
  const { sites } = JSON.parse(
    readFileSync(join(repoRoot, "tests", "dataset", "sites.json"), "utf8"),
  );
  const { personas } = JSON.parse(
    readFileSync(join(repoRoot, "tests", "dataset", "personas.json"), "utf8"),
  );
  const sources = JSON.parse(
    readFileSync(join(datasetDir, "sources.json"), "utf8"),
  );
  const byId = new Map(sources.records.map((record) => [record.id, record]));

  const faces = Object.fromEntries(
    FACE_FILES.map((name) => [
      name,
      "data:image/png;base64," +
        readFileSync(join(facesDir, `${name}.png`)).toString("base64"),
    ]),
  );

  const { server, port } = await startDatasetServer();
  // Headed, like the browser suite that will be scored against this ground truth. It is
  // not a cosmetic difference: a headless Chromium driven through Playwright's viewport
  // emulation hides the scrollbar, so the page lays out 15 pixels wider than it does in the
  // headed window the extension actually runs in. On a centred layout that moved every box
  // by eight pixels and dropped recall on a product grid to 29%.
  const browser = await chromium.launch({
    ...browserOptions(),
    headless: false,
  });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
  });
  // Offline, exactly as the evaluation runs. A snapshot with one absolute image URL still
  // in it would load here and be blocked there, and the page would then lay out differently
  // in each - which showed up as a product grid whose every ground-truth box was in the
  // wrong place, and a recall figure of 29% that was measuring nothing but that.
  await context.route("**/*", async (route) => {
    if (route.request().url().startsWith("http://127.0.0.1"))
      await route.continue();
    else await route.abort();
  });

  const written = [];
  const wanted = sites.filter(
    (site) => byId.get(site.id)?.ok && (!only || only.includes(site.id)),
  );

  for (const [index, site] of wanted.entries()) {
    process.stdout.write(`[${index + 1}/${wanted.length}] ${site.id} ... `);
    const page = await context.newPage();
    try {
      const random = seeded(hash(site.id));
      const persona = personas[index % personas.length];
      const faceName = FACE_FILES[index % FACE_FILES.length];
      const spans = spansFor(site.id, persona, random);
      // One of the ten also appears as pixels rather than text, so the vision half of the
      // firewall has something to catch: a phone number that exists only in an image.
      spans[0].pixelText = `Contact ${persona.phone}`;

      await page.goto(`http://127.0.0.1:${port}/${site.id}`, {
        waitUntil: "load",
      });
      await page.evaluate(() => window.scrollTo(0, 0));
      const result = await page.evaluate(annotate, {
        spans,
        faceImage: faces[faceName],
        viewport: VIEWPORT,
      });

      const elements = await oracle(page);

      writeFileSync(
        join(datasetDir, `${site.id}.html.gz`),
        gzipSync(Buffer.from(result.html, "utf8"), { level: 9 }),
      );
      await page.screenshot({
        path: join(datasetDir, `${site.id}.jpg`),
        type: "jpeg",
        quality: 78,
      });

      const truth = {
        id: site.id,
        type: site.type,
        sourceUrl: byId.get(site.id).finalUrl ?? site.url,
        capturedAt: byId.get(site.id).capturedAt,
        annotatedAt: new Date().toISOString(),
        viewport: VIEWPORT,
        documentHeight: result.documentHeight,
        persona: persona.name,
        elements,
        pii: spans
          .filter((span) => result.placed.includes(span.id))
          .map((span) => ({
            id: span.id,
            type: span.type,
            value: span.value,
            text: span.text,
            bbox: result.truthBoxes[span.id] ?? null,
          })),
        texts: result.texts,
        vision: {
          faces: [
            { id: "face_1", source: `${faceName}.png`, bbox: result.faceBox },
          ],
          pixelText: [
            {
              id: "vis_text_1",
              text: "Balance due 12,480.00",
              bbox: result.textBox,
              pii: null,
            },
            {
              id: "vis_pii_1",
              text: `Contact ${persona.phone}`,
              bbox: result.piiBox,
              pii: { type: "PHONE", value: persona.phone },
            },
          ],
        },
      };
      writeFileSync(
        join(datasetDir, `${site.id}.json`),
        JSON.stringify(truth, null, 2) + "\n",
        "utf8",
      );
      written.push({
        id: site.id,
        elements: elements.length,
        pii: truth.pii.length,
      });
      console.log(
        `${elements.length} oracle elements, ${truth.pii.length} PII spans`,
      );
    } catch (error) {
      console.log(`FAILED: ${String(error).split("\n")[0].slice(0, 160)}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  server.close();

  const index = {
    version: "1.0",
    annotatedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    screens: written.length,
    piiSpans: written.reduce((total, row) => total + row.pii, 0),
    oracleElements: written.reduce((total, row) => total + row.elements, 0),
    rows: written,
  };
  mkdirSync(datasetDir, { recursive: true });
  writeFileSync(
    join(datasetDir, "index.json"),
    JSON.stringify(index, null, 2) + "\n",
    "utf8",
  );

  console.log(
    `\nAnnotated ${written.length} screens: ${index.oracleElements} oracle elements, ` +
      `${index.piiSpans} PII spans.`,
  );
  if (written.length < 30) process.exitCode = 1;
}

await main();
