import browser from "webextension-polyfill";
import { analyzeScreenshot, warmUpVision, type WarmUpReport } from "./analyze";
import { describeError } from "../shared/errors";
import { fail, ok, type Reply, type ToOffscreen } from "../shared/messages";

/**
 * The offscreen document: an extension-origin page whose only job is to look at pixels.
 *
 * It exists because neither of the other two contexts can do this work. A service worker
 * has no DOM, no canvas and cannot construct a Worker, so Tesseract cannot run there at
 * all. A content script has a DOM but belongs to the visited site's origin, so it cannot
 * load an extension-origin worker script, and anything it does run is subject to that
 * site's CSP. This page is ours, hidden, and never navigated.
 *
 * It receives a screenshot the background worker took, analyses it, and returns counts,
 * text and rectangles. The image itself goes no further than this document, and is
 * released as soon as the pass returns.
 */

browser.runtime.onMessage.addListener((message: unknown) => {
  const request = message as ToOffscreen;
  if (request?.type === "privagent/vision-warm") return warm();
  if (request?.type === "privagent/vision-run") return analyze(request);
  if (request?.type === "privagent/verify-names-run") return verifyNames(request);
  return undefined;
});

/** Loads the model and starts the OCR worker, so the first task is not the slowest one. */
async function warm(): Promise<Reply<WarmUpReport>> {
  try {
    return ok(await warmUpVision());
  } catch (error) {
    const described = describeError(error);
    console.warn("PrivAgent vision warm-up failed:", described.message);
    return fail(described);
  }
}

async function analyze(request: Extract<ToOffscreen, { type: "privagent/vision-run" }>) {
  try {
    return ok(await analyzeScreenshot(request.dataUrl, request.regions, request.viewport));
  } catch (error) {
    const described = describeError(error);
    console.warn("PrivAgent vision pass failed:", described.message);
    return fail(described) as Reply<never>;
  }
}

async function verifyNames(request: Extract<ToOffscreen, { type: "privagent/verify-names-run" }>) {
  try {
    const { verifyNamesInDocument } = await import("./verifyNames");
    return ok(await verifyNamesInDocument(request.items));
  } catch (error) {
    const described = describeError(error);
    console.warn("PrivAgent name verification failed:", described.message);
    return fail(described) as Reply<never>;
  }
}
