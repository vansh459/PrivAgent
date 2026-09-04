import type { BoundingBox, DomScreenElement } from "./domWalker";

export interface VisionScreenElement {
  id: string;
  role: string;
  text: string;
  bbox: BoundingBox;
  source: "vision";
  sensitive: boolean;
  confidence: number;
}

export type PerceivedElement = DomScreenElement | VisionScreenElement;

function overlap(a: BoundingBox, b: BoundingBox): number {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a[2] * a[3] + b[2] * b[3] - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Prefers DOM semantics while retaining vision-only regions. */
export function fuseScreenElements(
  dom: DomScreenElement[],
  vision: VisionScreenElement[],
): PerceivedElement[] {
  return [
    ...dom,
    ...vision.filter((item) => !dom.some((element) => overlap(element.bbox, item.bbox) >= 0.7)),
  ];
}
