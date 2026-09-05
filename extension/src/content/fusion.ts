import type { BoundingBox, ScreenStateElement } from "../schemas/screenState";

/** Intersection-over-union of two viewport rectangles. */
export function overlap(a: BoundingBox, b: BoundingBox): number {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a[2] * a[3] + b[2] * b[3] - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Above this IoU, a vision detection is treated as the same region as a DOM element. */
export const DUPLICATE_IOU_THRESHOLD = 0.7;

/**
 * Prefers DOM semantics while retaining vision-only regions.
 *
 * The DOM knows an element's role and label exactly; vision only infers them. So where
 * both describe the same rectangle the DOM entry wins, and vision contributes what the
 * DOM cannot see - canvas, video, images and cross-origin iframes.
 */
export function fuseScreenElements(
  dom: ScreenStateElement[],
  vision: ScreenStateElement[],
): ScreenStateElement[] {
  return [
    ...dom,
    ...vision.filter(
      (item) => !dom.some((element) => overlap(element.bbox, item.bbox) >= DUPLICATE_IOU_THRESHOLD),
    ),
  ];
}
