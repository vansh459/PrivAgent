import { beforeEach, describe, expect, it, vi } from "vitest";
import { layoutById } from "./helpers/layout";
import { collectVisualRegions, runVisionPass, tryVisionPass } from "../src/content/visionPass";
import {
  MIN_OCR_CONFIDENCE,
  analyzeScreenshot,
  type Screenshot,
  type Viewport,
  type VisualRegion,
} from "../src/vision/analyze";
import { fuseScreenElements } from "../src/content/fusion";
import { perceiveDom } from "../src/content/domWalker";
import type { ScreenStateElement } from "../src/schemas/screenState";

vi.mock("webextension-polyfill", () => ({
  default: { runtime: { sendMessage: vi.fn(async () => ({ ok: true, value: {} })) } },
}));

/**
 * The vision pass across both of its halves, and its fusion with the DOM.
 *
 * The split under test is the one the browser forces: the content script can see layout
 * but cannot run a worker on the extension's origin, so it collects regions and an
 * extension-origin document does the looking. These tests join the two halves directly -
 * the real region collector feeding the real analysis - with only the screenshot, the
 * detector and the OCR worker stubbed.
 *
 * Phase 2.4's criterion is that no two elements describe the same on-screen region across
 * five test pages. That is asserted over every pair in every fused output, rather than
 * over the two or three a test author happened to think of.
 */

const screenshot: Screenshot = {
  pixels: { width: 1280, height: 800, data: new Uint8ClampedArray(1280 * 800 * 4) },
  source: {} as CanvasImageSource,
};

interface Fixture {
  faces?: { bbox: [number, number, number, number]; confidence: number }[];
  reads?: { text: string; confidence: number }[];
}

function seams(overrides: Fixture = {}) {
  return {
    decode: vi.fn(async () => screenshot),
    detect: vi.fn(async () => overrides.faces ?? []),
    read: vi.fn(async (_source: unknown, regions: readonly unknown[]) =>
      regions.map((_region, index) => overrides.reads?.[index] ?? { text: "", confidence: 0 }),
    ),
  };
}

/** The content-side pass with the analysis stubbed - the two halves, joined as in production. */
function pass(overrides: Fixture = {}) {
  const injected = seams(overrides);
  const perceive = vi.fn(async (regions: VisualRegion[], viewport: Viewport) =>
    analyzeScreenshot("data:image/png;base64,x", regions, viewport, injected),
  );
  return { injected, perceive, options: { perceive } };
}

function iou(a: readonly number[], b: readonly number[]): number {
  const left = Math.max(a[0]!, b[0]!);
  const top = Math.max(a[1]!, b[1]!);
  const right = Math.min(a[0]! + a[2]!, b[0]! + b[2]!);
  const bottom = Math.min(a[1]! + a[3]!, b[1]! + b[3]!);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a[2]! * a[3]! + b[2]! * b[3]! - intersection;
  return union <= 0 ? 0 : intersection / union;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("collectVisualRegions", () => {
  it("finds the elements whose painted content the DOM cannot describe", () => {
    document.body.innerHTML = `
      <canvas id="chart"></canvas>
      <video id="feed"></video>
      <img id="photo" alt="Team photo" />
      <iframe id="frame"></iframe>
      <p id="text">plain text</p>`;
    layoutById({
      chart: [0, 0, 400, 300],
      feed: [400, 0, 320, 240],
      photo: [0, 300, 200, 200],
      frame: [400, 300, 300, 200],
    });

    expect(collectVisualRegions().map((region) => region.role)).toEqual([
      "canvas",
      "video",
      "img",
      "iframe",
    ]);
  });

  it("skips icons and spacers, which cost more to read than they return", () => {
    document.body.innerHTML = `<img id="icon" /><canvas id="chart"></canvas>`;
    layoutById({ icon: [0, 0, 16, 16], chart: [0, 40, 300, 200] });

    expect(collectVisualRegions().map((region) => region.role)).toEqual(["canvas"]);
  });

  it("skips regions scrolled out of the viewport, which are not in the screenshot", () => {
    document.body.innerHTML = `<canvas id="below"></canvas><canvas id="visible"></canvas>`;
    layoutById({ below: [0, 2000, 400, 300], visible: [0, 100, 400, 300] });

    expect(collectVisualRegions()).toHaveLength(1);
  });

  it("records author-supplied descriptions without treating them as observations", () => {
    document.body.innerHTML = `<img id="photo" alt="A cat" /><canvas id="chart"></canvas>`;
    layoutById({ photo: [0, 0, 200, 200], chart: [0, 300, 200, 200] });

    expect(collectVisualRegions().map((region) => region.describedText)).toEqual(["A cat", ""]);
  });
});

describe("runVisionPass", () => {
  it("takes no screenshot at all when the page has nothing visual on it", async () => {
    document.body.innerHTML = `<button id="go">Go</button>`;
    layoutById({ go: [0, 0, 80, 30] });
    const { perceive, options } = pass();

    const result = await runVisionPass(options);

    expect(result).toMatchObject({ captured: false, elements: [], faces: 0 });
    expect(
      perceive,
      "a screenshot was requested for a page with nothing to see",
    ).not.toHaveBeenCalled();
  });

  it("marks every detected face sensitive, so the context builder withholds it", async () => {
    document.body.innerHTML = `<img id="photo" />`;
    layoutById({ photo: [10, 20, 300, 200] });

    const result = await runVisionPass(
      pass({ faces: [{ bbox: [40, 60, 80, 90], confidence: 0.97 }] }).options,
    );

    expect(result.elements[0]).toEqual({
      id: "face_1",
      role: "face",
      text: "",
      bbox: [40, 60, 80, 90],
      source: "vision_face",
      sensitive: true,
      confidence: 0.97,
    });
    expect(result.faces).toBe(1);
    expect(result.captured).toBe(true);
  });

  it("reads only regions the DOM left without text", async () => {
    document.body.innerHTML = `<img id="described" alt="Signed contract" /><canvas id="chart"></canvas>`;
    layoutById({ described: [0, 0, 200, 200], chart: [0, 300, 400, 200] });
    const { injected, options } = pass({ reads: [{ text: "Revenue Q3", confidence: 88 }] });

    const result = await runVisionPass(options);

    expect(injected.read.mock.calls[0]![1], "a described region was read anyway").toHaveLength(1);
    expect(result.elements).toEqual([
      {
        id: "vision_2",
        role: "canvas",
        text: "Revenue Q3",
        bbox: [0, 300, 400, 200],
        source: "vision_ocr",
        sensitive: false,
        confidence: 0.88,
      },
    ]);
  });

  it("discards a low-confidence read rather than reporting noise as screen text", async () => {
    document.body.innerHTML = `<canvas id="chart"></canvas>`;
    layoutById({ chart: [0, 0, 400, 300] });

    const result = await runVisionPass(
      pass({ reads: [{ text: "|||l1", confidence: MIN_OCR_CONFIDENCE - 1 }] }).options,
    );

    expect(result.elements).toEqual([]);
  });

  it("sends the viewport size, so boxes come back in CSS pixels", async () => {
    document.body.innerHTML = `<canvas id="chart"></canvas>`;
    layoutById({ chart: [0, 0, 400, 300] });
    const { perceive, options } = pass();

    await runVisionPass(options);

    expect(perceive.mock.calls[0]![1]).toEqual({
      width: window.innerWidth,
      height: window.innerHeight,
    });
  });
});

describe("tryVisionPass", () => {
  it("gives up on a pass that never returns, rather than hanging the task", async () => {
    document.body.innerHTML = `<canvas id="chart"></canvas>`;
    layoutById({ chart: [0, 0, 400, 300] });

    // `captureVisibleTab` can block forever on a window that is not compositing. Without
    // a bound, the whole task stops there with no error and no result.
    const result = await tryVisionPass({
      perceive: () => new Promise(() => undefined),
      timeoutMs: 20,
    });

    expect(result.error).toContain("did not finish within 20 ms");
    expect(result.captured).toBe(false);
  });

  it("reports a failure instead of returning a silent empty result", async () => {
    document.body.innerHTML = `<canvas id="chart"></canvas>`;
    layoutById({ chart: [0, 0, 400, 300] });

    const result = await tryVisionPass({
      perceive: async () => {
        throw new Error("captureVisibleTab is not allowed on this page");
      },
    });

    // The distinction that matters: "we could not look" must never read as "nothing there".
    expect(result.error).toContain("captureVisibleTab");
    expect(result.captured).toBe(false);
    expect(result.elements).toEqual([]);
  });
});

/** Five page shapes, each with real DOM elements and vision output over the same screen. */
const PAGES: {
  id: string;
  html: string;
  layout: Record<string, [number, number, number, number]>;
  faces: { bbox: [number, number, number, number]; confidence: number }[];
  reads: { text: string; confidence: number }[];
}[] = [
  {
    id: "form",
    html: `<canvas id="signature"></canvas><button id="submit">Submit</button>`,
    layout: { signature: [40, 400, 400, 160], submit: [40, 600, 120, 40] },
    faces: [],
    reads: [{ text: "Sign here", confidence: 91 }],
  },
  {
    id: "dashboard",
    html: `<canvas id="chart"></canvas><a id="export" href="/x">Export</a><img id="avatar" />`,
    layout: { chart: [0, 100, 600, 400], export: [620, 100, 90, 30], avatar: [700, 20, 64, 64] },
    // The avatar's face lands inside the avatar's own region - the overlapping case.
    faces: [{ bbox: [704, 24, 56, 56], confidence: 0.95 }],
    reads: [
      { text: "Revenue by quarter", confidence: 87 },
      { text: "", confidence: 0 },
    ],
  },
  {
    id: "portal",
    html: `<img id="scan" /><button id="download">Download</button>`,
    layout: { scan: [100, 100, 500, 600], download: [700, 100, 140, 40] },
    faces: [{ bbox: [180, 180, 120, 140], confidence: 0.93 }],
    reads: [{ text: "Aadhaar 1234 5678 9012", confidence: 84 }],
  },
  {
    id: "ecommerce",
    html: `<img id="product" /><button id="buy">Buy now</button><video id="demo"></video>`,
    layout: { product: [0, 0, 400, 400], buy: [420, 0, 100, 40], demo: [0, 420, 400, 300] },
    faces: [],
    reads: [
      { text: "Rs 12,499", confidence: 90 },
      { text: "Product demo", confidence: 72 },
    ],
  },
  {
    id: "spa",
    html: `<canvas id="map"></canvas><div id="menu" role="menuitem" aria-label="Filters"></div>`,
    layout: { map: [0, 0, 900, 600], menu: [700, 700, 200, 40] },
    faces: [],
    reads: [{ text: "Map view", confidence: 80 }],
  },
];

describe("fusion across five page shapes", () => {
  it("produces no two elements describing the same on-screen region", async () => {
    for (const page of PAGES) {
      document.body.innerHTML = page.html;
      layoutById(page.layout);

      const { elements: domElements } = perceiveDom();
      const vision = await runVisionPass(pass({ faces: page.faces, reads: page.reads }).options);
      const fused = fuseScreenElements(domElements, vision.elements);

      expect(fused.length, `${page.id}: nothing perceived`).toBeGreaterThan(0);
      expect(
        fused.some((element) => element.source !== "dom"),
        `${page.id}: vision contributed nothing, so fusion is untested here`,
      ).toBe(true);

      for (let i = 0; i < fused.length; i += 1) {
        for (let j = i + 1; j < fused.length; j += 1) {
          const a = fused[i]!;
          const b = fused[j]!;
          expect(
            iou(a.bbox, b.bbox),
            `${page.id}: ${a.id} (${a.source}) and ${b.id} (${b.source}) describe the same region`,
          ).toBeLessThan(0.7);
        }
      }
    }
  });

  it("keeps the DOM's description when both observers saw the same rectangle", async () => {
    document.body.innerHTML = `<canvas id="map"></canvas><div id="menu" role="menuitem" aria-label="Filters"></div>`;
    // Both on the same rectangle, kept inside jsdom's 1024x768 viewport: a region hanging
    // off the edge is clipped to the screenshot and would then be a *different* rectangle
    // to the DOM's - which is real behaviour, not something to test around.
    layoutById({ menu: [700, 0, 200, 40], map: [700, 0, 200, 40] });

    const { elements: domElements } = perceiveDom();
    const vision = await runVisionPass(
      pass({ reads: [{ text: "Map view", confidence: 80 }] }).options,
    );
    const fused = fuseScreenElements(domElements, vision.elements);

    expect(fused.filter((element: ScreenStateElement) => element.bbox[0] === 700)).toHaveLength(1);
    expect(fused[0]!.source).toBe("dom");
  });

  it("carries vision-detected faces through fusion as sensitive elements", async () => {
    const page = PAGES[2]!;
    document.body.innerHTML = page.html;
    layoutById(page.layout);

    const { elements: domElements } = perceiveDom();
    const vision = await runVisionPass(pass({ faces: page.faces, reads: page.reads }).options);
    const fused = fuseScreenElements(domElements, vision.elements);

    const face = fused.find((element: ScreenStateElement) => element.source === "vision_face");
    expect(face?.sensitive).toBe(true);
  });
});
