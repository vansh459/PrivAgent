import type { BoundingBox } from "../schemas/screenState";
import type { RgbaSource } from "../content/faceDetection";

/**
 * Paints over sensitive regions of a captured screen, in place.
 *
 * PrivAgent never transmits pixels, so this is not what stops a face reaching the server -
 * the context builder does that, by withholding the element. This is the layer underneath:
 * once a face has been detected, the only copy of the screenshot the pipeline keeps is one
 * with the face already destroyed. Nothing downstream - the OCR worker, a debug export, a
 * future feature nobody has written yet - can leak what is no longer in the buffer.
 *
 * The mask is an opaque fill rather than a blur. A blur of a small face is reversible
 * enough to be a bad idea, and "visibly masked" should mean exactly that: the pixels are
 * gone, not smeared.
 */

/** Grey chosen to read as deliberate rather than as a rendering failure. */
export const MASK_COLOUR: readonly [number, number, number] = [40, 44, 52];

/**
 * Detector boxes sit tight to the face - eyebrows to chin, ear to ear - which leaves hair,
 * jawline and ears outside them. Ten percent of the box on each side covers that without
 * swallowing the surrounding layout.
 */
export const MASK_PADDING = 0.1;

export function paddedBox(box: BoundingBox, width: number, height: number): BoundingBox {
  const padX = Math.round(box[2] * MASK_PADDING);
  const padY = Math.round(box[3] * MASK_PADDING);
  const left = Math.max(0, box[0] - padX);
  const top = Math.max(0, box[1] - padY);
  return [
    left,
    top,
    Math.min(width - left, box[2] + padX * 2),
    Math.min(height - top, box[3] + padY * 2),
  ];
}

/**
 * Fills every region with the mask colour. Returns the number of pixels destroyed, so a
 * caller can record that redaction actually happened rather than assuming it did.
 */
export function maskRegions(image: RgbaSource, boxes: readonly BoundingBox[]): number {
  let painted = 0;

  for (const box of boxes) {
    const [left, top, width, height] = paddedBox(box, image.width, image.height);
    for (let y = top; y < top + height; y += 1) {
      if (y < 0 || y >= image.height) continue;
      for (let x = left; x < left + width; x += 1) {
        if (x < 0 || x >= image.width) continue;
        const index = (y * image.width + x) * 4;
        image.data[index] = MASK_COLOUR[0];
        image.data[index + 1] = MASK_COLOUR[1];
        image.data[index + 2] = MASK_COLOUR[2];
        image.data[index + 3] = 255;
        painted += 1;
      }
    }
  }

  return painted;
}

/**
 * True when every pixel of the box carries the mask colour.
 *
 * Used by the evaluation to check the claim rather than the intent: "we called the masking
 * function" is not evidence that a face is gone.
 */
export function isFullyMasked(image: RgbaSource, box: BoundingBox): boolean {
  const [left, top, width, height] = box;
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      if (y < 0 || y >= image.height || x < 0 || x >= image.width) continue;
      const index = (y * image.width + x) * 4;
      if (
        image.data[index] !== MASK_COLOUR[0] ||
        image.data[index + 1] !== MASK_COLOUR[1] ||
        image.data[index + 2] !== MASK_COLOUR[2]
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Copies the masked pixels back onto the drawable the OCR worker reads from.
 *
 * The two representations of a screenshot have to stay in step: face detection works on
 * the `ImageData`, OCR crops from the canvas. Masking one and reading the other would
 * leave the face in exactly the buffer that gets handed to a worker.
 */
export function applyMaskToCanvas(source: CanvasImageSource, image: RgbaSource): void {
  const canvas = source as HTMLCanvasElement;
  const context = canvas.getContext?.("2d") as CanvasRenderingContext2D | null | undefined;
  if (!context || typeof ImageData === "undefined") return;
  context.putImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    0,
    0,
  );
}
