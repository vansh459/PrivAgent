import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseSharedOcrWorker, sharedOcrWorker, type OcrWorker } from "../src/content/ocr";
import {
  cancelOcrIdleRelease,
  OCR_IDLE_RELEASE_MS,
  scheduleOcrIdleRelease,
} from "../src/vision/analyze";

/**
 * The OCR worker is the largest retained allocation in the vision host; these tests pin
 * the lifecycle contract: released after the idle window, never released mid-pass, and a
 * new pass after release simply starts a fresh worker.
 */

describe("OCR worker idle release", () => {
  let terminated: number;

  const fakeWorker = (): Promise<OcrWorker> =>
    Promise.resolve({
      recognize: async () => ({ data: { text: "", confidence: 0 } }),
      terminate: async () => {
        terminated += 1;
      },
    });

  beforeEach(() => {
    terminated = 0;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    cancelOcrIdleRelease();
    vi.useRealTimers();
    await releaseSharedOcrWorker();
  });

  it("terminates the shared worker once the idle window elapses", async () => {
    await sharedOcrWorker(fakeWorker);
    scheduleOcrIdleRelease();

    await vi.advanceTimersByTimeAsync(OCR_IDLE_RELEASE_MS - 1);
    expect(terminated).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(terminated).toBe(1);
  });

  it("does not fire while a new pass has cancelled the countdown", async () => {
    await sharedOcrWorker(fakeWorker);
    scheduleOcrIdleRelease();
    cancelOcrIdleRelease(); // a pass began

    await vi.advanceTimersByTimeAsync(OCR_IDLE_RELEASE_MS * 2);
    expect(terminated).toBe(0);
  });

  it("re-arming pushes the countdown back instead of stacking timers", async () => {
    await sharedOcrWorker(fakeWorker);
    scheduleOcrIdleRelease();
    await vi.advanceTimersByTimeAsync(OCR_IDLE_RELEASE_MS - 1_000);
    scheduleOcrIdleRelease(); // another pass finished just before expiry

    await vi.advanceTimersByTimeAsync(2_000);
    expect(terminated).toBe(0); // old timer must not have fired
    await vi.advanceTimersByTimeAsync(OCR_IDLE_RELEASE_MS);
    expect(terminated).toBe(1);
  });

  it("a released worker is replaced on the next request, not resurrected", async () => {
    const first = await sharedOcrWorker(fakeWorker);
    scheduleOcrIdleRelease();
    await vi.advanceTimersByTimeAsync(OCR_IDLE_RELEASE_MS + 1);

    const second = await sharedOcrWorker(fakeWorker);
    expect(second).not.toBe(first);
  });
});
