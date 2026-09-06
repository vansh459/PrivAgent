import browser from "webextension-polyfill";
import type { NameVerifyItem } from "../content/nameVerifier";
import type { VisionAnalysis, Viewport, VisualRegion } from "../vision/analyze";
import { PrivAgentError } from "../shared/errors";
import type { Reply, ToOffscreen } from "../shared/messages";

/**
 * Drives the vision pass from the background worker.
 *
 * The split is forced by what each context is allowed to do: only an extension context
 * can call `captureVisibleTab`, and only a document can decode an image or run an OCR
 * worker. So the worker captures, and a hidden extension-origin document analyses.
 *
 * On Chrome that document is an offscreen document. On Firefox MV3 the background is an
 * event page rather than a service worker - it already has a DOM - so the analysis runs
 * there directly and no offscreen document is created. Both paths run the same module on
 * the same origin; only who hosts it differs.
 */

const OFFSCREEN_PATH = "src/ui/offscreen.html";

interface OffscreenApi {
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  hasDocument?(): Promise<boolean>;
}

function offscreenApi(): OffscreenApi | undefined {
  return (globalThis as typeof globalThis & { chrome?: { offscreen?: OffscreenApi } }).chrome
    ?.offscreen;
}

let creating: Promise<void> | undefined;

/**
 * Ensures the offscreen document exists, creating it at most once.
 *
 * Chrome permits exactly one offscreen document per extension and throws if asked for a
 * second, so concurrent tasks have to share the in-flight creation rather than each
 * starting their own.
 */
async function ensureOffscreenDocument(api: OffscreenApi): Promise<void> {
  if (await api.hasDocument?.()) return;
  creating ??= api
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["WORKERS"],
      justification:
        "Runs on-device OCR and face detection over a screenshot of the active tab, so that " +
        "no screen content leaves the device.",
    })
    .finally(() => {
      creating = undefined;
    });

  try {
    await creating;
  } catch (error) {
    // A racing task may have created it between our check and our call, which is fine.
    if (!(await api.hasDocument?.())) throw error;
  }
}

/**
 * Creates the vision host and loads its models ahead of the first task.
 *
 * Called when the popup opens: the user is typing a task at that moment, which is exactly
 * the window in which ~33 MB of runtime, model and language data can be loaded for free.
 * Cold, the first pass measured tens of seconds; warm, it is a fraction of that.
 */
export async function warmVisionHost(): Promise<void> {
  const started = Date.now();
  const api = offscreenApi();
  let report: unknown;

  if (api) {
    await ensureOffscreenDocument(api);
    const hosted = Date.now() - started;
    const reply = (await browser.runtime.sendMessage({
      type: "privagent/vision-warm",
    } satisfies ToOffscreen)) as Reply<unknown>;
    report = { host: `${hosted} ms`, load: reply?.ok ? reply.value : reply };
  } else if (typeof document !== "undefined") {
    const { warmUpVision } = await import("../vision/analyze");
    report = { load: await warmUpVision() };
  } else {
    return;
  }

  // Logged rather than audited: warm-up is not part of any task, and the audit trail is
  // per task. It is here because "the first task took a minute" is otherwise unattributable.
  console.info(
    `PrivAgent vision warm-up finished in ${Date.now() - started} ms`,
    JSON.stringify(report),
  );
}

/** Analyses the screenshot wherever this browser allows a document to exist. */
export async function analyzeInHost(
  dataUrl: string,
  regions: VisualRegion[],
  viewport: Viewport,
): Promise<VisionAnalysis> {
  const api = offscreenApi();
  if (api) {
    await ensureOffscreenDocument(api);
    const message: ToOffscreen = { type: "privagent/vision-run", dataUrl, regions, viewport };
    const reply = (await browser.runtime.sendMessage(message)) as Reply<VisionAnalysis>;
    if (!reply?.ok) {
      throw new PrivAgentError(
        reply?.error?.code ?? "capability_unavailable",
        reply?.error?.message ?? "The offscreen vision document did not respond",
      );
    }
    return reply.value;
  }

  // Firefox MV3: the background is an event page, so it can do this itself. The import is
  // dynamic because a Chrome service worker must never evaluate a module that touches
  // `document` at load time.
  if (typeof document !== "undefined") {
    const { analyzeScreenshot } = await import("../vision/analyze");
    return analyzeScreenshot(dataUrl, regions, viewport);
  }

  throw new PrivAgentError(
    "capability_unavailable",
    "This browser offers no extension-origin document to run local vision in",
  );
}

/**
 * Scores NAME candidates in the same extension-origin host the vision pass uses.
 *
 * The routing mirrors `analyzeInHost` exactly - Chrome's offscreen document, or the
 * Firefox event page itself - because the constraint is the same: the model's WASM has to
 * instantiate on our origin, not the visited page's.
 */
export async function verifyNamesInHost(items: NameVerifyItem[]): Promise<boolean[][]> {
  const api = offscreenApi();
  if (api) {
    await ensureOffscreenDocument(api);
    const message: ToOffscreen = { type: "privagent/verify-names-run", items };
    const reply = (await browser.runtime.sendMessage(message)) as Reply<boolean[][]>;
    if (!reply?.ok) {
      throw new PrivAgentError(
        reply?.error?.code ?? "capability_unavailable",
        reply?.error?.message ?? "The offscreen vision document did not respond",
      );
    }
    return reply.value;
  }

  if (typeof document !== "undefined") {
    const { verifyNamesInDocument } = await import("../vision/verifyNames");
    return verifyNamesInDocument(items);
  }

  throw new PrivAgentError(
    "capability_unavailable",
    "This browser offers no extension-origin document to run the name verifier in",
  );
}
