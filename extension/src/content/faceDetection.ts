import type { BoundingBox } from "./domWalker";

export interface FaceDetection {
  bbox: BoundingBox;
  confidence: number;
}

interface NativeFaceDetector {
  detect(source: CanvasImageSource): Promise<Array<{ boundingBox: DOMRectReadOnly }>>;
}

type FaceDetectorConstructor = new (options?: {
  fastMode?: boolean;
  maxDetectedFaces?: number;
}) => NativeFaceDetector;

function nativeDetector(): FaceDetectorConstructor | undefined {
  return (globalThis as typeof globalThis & { FaceDetector?: FaceDetectorConstructor })
    .FaceDetector;
}

/** Detect faces on-device using the browser's local Shape Detection implementation. */
export async function detectFaces(source: CanvasImageSource): Promise<FaceDetection[]> {
  const Detector = nativeDetector();
  if (!Detector) return [];
  const faces = await new Detector({ fastMode: false, maxDetectedFaces: 20 }).detect(source);
  return faces.map(({ boundingBox }) => ({
    bbox: [
      Math.round(boundingBox.x),
      Math.round(boundingBox.y),
      Math.round(boundingBox.width),
      Math.round(boundingBox.height),
    ],
    confidence: 1,
  }));
}
