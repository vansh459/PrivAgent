import browser from "webextension-polyfill";
import type { VisionAnalysis, VisualRegion } from "../vision/analyze";
import { describeError, PrivAgentError } from "../shared/errors";
import type { Reply, ToBackground } from "../shared/messages";

/**
 * The content script's half of the vision pass: find what to look at, then ask.
 *
 * Only the content script can see the page's layout, so region discovery has to happen
 * here. The looking itself happens in an extension-origin document (see
 * `vision/analyze.ts`), which is where a Worker can be created from an extension URL and
 * where a screenshot of the user's screen is not being decoded inside the visited site's
 * own renderer.
 */

/** Elements whose painted content the DOM cannot describe in text. */
const VISUAL_SELECTOR = "canvas, video, svg, img, picture, iframe";

/** Below this, a region is an icon or a spacer; OCR on it costs more than it returns. */
const MIN_REGION_SIDE = 32;

export type { VisualRegion } from "../vision/analyze";

/**
 * Finds the visual regions on the page, in viewport coordinates.
 *
 * A region that already carries an `alt` or `aria-label` is still returned - the analysis
 * decides whether to read it - because an author-supplied description is a claim about an
 * image, not an observation of it, and a redaction pipeline cannot run on claims.
 */
export function collectVisualRegions(root: ParentNode = document): VisualRegion[] {
  const regions: VisualRegion[] = [];

  for (const element of root.querySelectorAll<HTMLElement>(VISUAL_SELECTOR)) {
    const rect = element.getBoundingClientRect();
    if (rect.width < MIN_REGION_SIDE || rect.height < MIN_REGION_SIDE) continue;
    if (!isVisible(element)) continue;

    // Off-screen regions are not on the screenshot, so there is nothing to read.
    const view = element.ownerDocument.defaultView;
    const viewportWidth = view?.innerWidth ?? 0;
    const viewportHeight = view?.innerHeight ?? 0;
    if (rect.right <= 0 || rect.bottom <= 0) continue;
    if (viewportWidth && rect.left >= viewportWidth) continue;
    if (viewportHeight && rect.top >= viewportHeight) continue;

    const left = Math.max(0, Math.round(rect.left));
    const top = Math.max(0, Math.round(rect.top));
    regions.push({
      id: `vision_${regions.length + 1}`,
      role: element.tagName.toLowerCase(),
      describedText:
        element.getAttribute("alt")?.trim() ||
        element.getAttribute("aria-label")?.trim() ||
        element.getAttribute("title")?.trim() ||
        "",
      bbox: [
        left,
        top,
        Math.round(Math.min(rect.right, viewportWidth || rect.right) - left),
        Math.round(Math.min(rect.bottom, viewportHeight || rect.bottom) - top),
      ],
    });
  }

  return regions;
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) return true;
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

export interface VisionPassResult extends VisionAnalysis {
  /** True when a screenshot was actually taken. False means the page had nothing to see. */
  captured: boolean;
}

export interface VisionPassOptions {
  root?: ParentNode;
  /** Injectable so the loop is testable without a browser or a background worker. */
  perceive?: (
    regions: VisualRegion[],
    viewport: { width: number; height: number },
  ) => Promise<VisionAnalysis>;
  /** Milliseconds the whole pass may take before the task proceeds without it. */
  timeoutMs?: number;
}

/**
 * How long the task will wait for vision before going on without it.
 *
 * Generous, because a cold pass also loads the models. Bounded, because
 * `captureVisibleTab` does not always fail when it cannot succeed: asked to photograph a
 * window that is not compositing - occluded by another window, or minimised - it can
 * simply never return. Observed hanging a task indefinitely, with the popup stuck on
 * "Perceiving the page locally...". A user whose agent has silently stopped is worse off
 * than one whose agent saw less.
 */
export const VISION_TIMEOUT_MS = 15_000;

async function requestVision(
  regions: VisualRegion[],
  viewport: { width: number; height: number },
): Promise<VisionAnalysis> {
  const message: ToBackground = { type: "privagent/perceive-vision", regions, viewport };
  const reply = (await browser.runtime.sendMessage(message)) as Reply<VisionAnalysis>;
  if (!reply?.ok) {
    throw new PrivAgentError(
      reply?.error?.code ?? "capability_unavailable",
      reply?.error?.message ?? "The vision pass did not complete",
    );
  }
  return reply.value;
}

/**
 * Runs the vision pass over the current viewport.
 *
 * Returns without capturing anything when the page has no visual regions at all - a
 * DOM-only page is perceived without a screenshot ever being taken.
 */
export async function runVisionPass(options: VisionPassOptions = {}): Promise<VisionPassResult> {
  const started = performance.now();
  const regions = collectVisualRegions(options.root ?? document);
  if (regions.length === 0) {
    return {
      elements: [],
      captured: false,
      faces: 0,
      pixelsRedacted: 0,
      regionsRead: 0,
      millis: Math.round(performance.now() - started),
      timings: { decodeMs: 0, detectMs: 0, ocrMs: 0 },
    };
  }

  const perceive = options.perceive ?? requestVision;
  const analysis = await withTimeout(
    perceive(regions, { width: window.innerWidth, height: window.innerHeight }),
    options.timeoutMs ?? VISION_TIMEOUT_MS,
  );
  return { ...analysis, captured: true };
}

function withTimeout<T>(work: Promise<T>, millis: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new PrivAgentError(
            "capability_unavailable",
            `the local vision pass did not finish within ${millis} ms`,
          ),
        ),
      millis,
    );
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Runs the vision pass, reporting failure rather than propagating it.
 *
 * Vision is additive: without it the agent still perceives the DOM, and refusing the task
 * because a screenshot failed would serve the user worse than running with less sight.
 * But it must be *reported* - a silent empty result is indistinguishable from "no faces
 * on screen", which is the failure mode that would quietly disable redaction.
 */
export async function tryVisionPass(
  options: VisionPassOptions = {},
): Promise<VisionPassResult & { error?: string }> {
  try {
    return await runVisionPass(options);
  } catch (error) {
    return {
      elements: [],
      captured: false,
      faces: 0,
      pixelsRedacted: 0,
      regionsRead: 0,
      millis: 0,
      timings: { decodeMs: 0, detectMs: 0, ocrMs: 0 },
      error: describeError(error).message,
    };
  }
}
