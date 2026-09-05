import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodePng, type RgbaImage } from "./png";

/**
 * The labelled 20-image face test set, composed at test time from five annotated crops.
 *
 * Ground truth is exact by construction: a face is pasted at a rectangle this file
 * chooses, so the label is the paste rectangle rather than someone's estimate of where a
 * face is in a photograph. That removes the largest source of error in a hand-annotated
 * set of this size - at 20 images, a few sloppy boxes move recall by whole percentage
 * points - and it makes the set regenerable rather than a binary blob nobody can audit.
 *
 * The five source faces are public-domain NASA portraits (see
 * `tests/dataset/faces/sources.json`), cropped to the face and not otherwise altered.
 * They vary in skin tone, age, sex and pose, because a detector that works on one
 * demographic and not another is a redaction failure aimed squarely at the people it
 * fails on.
 *
 * What this set does *not* establish: performance on faces in natural photographs -
 * occluded, motion-blurred, lit from one side, or at steep angles. It measures the case
 * PrivAgent actually meets, which is a face composited into a rendered page.
 */

export interface LabelledFace {
  /** Ground-truth `[x, y, width, height]` in the scene's own pixels. */
  bbox: [number, number, number, number];
  source: string;
}

export interface FaceScene {
  id: string;
  description: string;
  image: RgbaImage;
  faces: LabelledFace[];
}

const datasetDir = resolve(import.meta.dirname, "..", "..", "..", "tests", "dataset", "faces");

const FACE_IDS = ["armstrong", "bluford", "chawla", "jemison", "ride"] as const;
type FaceId = (typeof FACE_IDS)[number];

const cache = new Map<string, RgbaImage>();

function face(id: FaceId): RgbaImage {
  let image = cache.get(id);
  if (!image) {
    image = decodePng(readFileSync(resolve(datasetDir, `${id}.png`)));
    cache.set(id, image);
  }
  return image;
}

/** A deterministic PRNG, so every run scores the same pixels. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function blankScene(width: number, height: number, seed: number, style: SceneStyle): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const next = random(seed);
  const base = style === "dark" ? 28 : style === "grey" ? 150 : 246;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      // A slight vertical gradient plus noise: a flat fill is unrepresentative of a page
      // and unrepresentatively easy for a detector to segment against.
      const shade = base + Math.round((y / height) * 18) + Math.round(next() * 6);
      data[index] = shade;
      data[index + 1] = shade;
      data[index + 2] = style === "grey" ? shade - 6 : shade;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

type SceneStyle = "light" | "grey" | "dark";

/** Draws page furniture - cards, a header bar - so faces are not the only structure. */
function drawPanels(scene: RgbaImage, seed: number): void {
  const next = random(seed);
  for (let panel = 0; panel < 4; panel += 1) {
    const width = 120 + Math.round(next() * 260);
    const height = 40 + Math.round(next() * 120);
    const left = Math.round(next() * (scene.width - width));
    const top = Math.round(next() * (scene.height - height));
    const tone = 60 + Math.round(next() * 150);
    for (let y = top; y < top + height; y += 1) {
      for (let x = left; x < left + width; x += 1) {
        const index = (y * scene.width + x) * 4;
        scene.data[index] = tone;
        scene.data[index + 1] = tone;
        scene.data[index + 2] = Math.min(255, tone + 20);
      }
    }
  }
}

/** Nearest-neighbour paste at an arbitrary scale; returns the exact rectangle written. */
function paste(
  scene: RgbaImage,
  source: RgbaImage,
  left: number,
  top: number,
  scale: number,
): [number, number, number, number] {
  const width = Math.round(source.width * scale);
  const height = Math.round(source.height * scale);

  for (let y = 0; y < height; y += 1) {
    const sceneY = top + y;
    if (sceneY < 0 || sceneY >= scene.height) continue;
    const sourceY = Math.min(source.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x += 1) {
      const sceneX = left + x;
      if (sceneX < 0 || sceneX >= scene.width) continue;
      const from = (sourceY * source.width + Math.min(source.width - 1, Math.floor(x / scale))) * 4;
      const to = (sceneY * scene.width + sceneX) * 4;
      scene.data[to] = source.data[from]!;
      scene.data[to + 1] = source.data[from + 1]!;
      scene.data[to + 2] = source.data[from + 2]!;
      scene.data[to + 3] = 255;
    }
  }

  return [left, top, width, height];
}

/**
 * Degradations applied after pasting, over the face's own rectangle.
 *
 * A face that is blurred, or half-covered by a page element, is still a face and still
 * has to be redacted - so these scenes keep the paste rectangle as ground truth and ask
 * the detector to find it anyway. Without them the set is a row of clean frontal
 * portraits on flat backgrounds, which measures almost nothing.
 */
interface FacePlacement {
  id: FaceId;
  left: number;
  top: number;
  scale: number;
  /** Box-blur radius in pixels, as a downscaled or out-of-focus image would be. */
  blur?: number;
  /** Fraction of the face's height covered from the bottom, as page furniture would. */
  occludeBottom?: number;
}

interface SceneSpec {
  id: string;
  description: string;
  width: number;
  height: number;
  style: SceneStyle;
  panels: boolean;
  faces: FacePlacement[];
}

/** Separable box blur over one rectangle of the scene. */
function blurRegion(scene: RgbaImage, box: readonly number[], radius: number): void {
  const [left, top, width, height] = box as [number, number, number, number];
  const source = new Uint8ClampedArray(scene.data);
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = Math.min(scene.width - 1, Math.max(0, x + dx));
          const sy = Math.min(scene.height - 1, Math.max(0, y + dy));
          const index = (sy * scene.width + sx) * 4;
          r += source[index]!;
          g += source[index + 1]!;
          b += source[index + 2]!;
          count += 1;
        }
      }
      const to = (y * scene.width + x) * 4;
      scene.data[to] = r / count;
      scene.data[to + 1] = g / count;
      scene.data[to + 2] = b / count;
    }
  }
}

/** Covers the bottom of a face rectangle with an opaque bar, as a caption overlay would. */
function occludeBottom(scene: RgbaImage, box: readonly number[], fraction: number): void {
  const [left, top, width, height] = box as [number, number, number, number];
  const from = top + Math.round(height * (1 - fraction));
  for (let y = from; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      const index = (y * scene.width + x) * 4;
      scene.data[index] = 34;
      scene.data[index + 1] = 38;
      scene.data[index + 2] = 46;
    }
  }
}

/**
 * Twenty scenes, 27 faces.
 *
 * The mix is chosen around where a detector is expected to fail rather than where it is
 * expected to succeed: half-size and quarter-size faces, faces at the very edge of the
 * viewport, three faces in one scene, dark backgrounds, and one scene with no face at all
 * so a detector that simply always fires cannot score well.
 */
const SPECS: SceneSpec[] = [
  {
    id: "profile-avatar",
    description: "single avatar on a light settings page",
    width: 1280,
    height: 800,
    style: "light",
    panels: true,
    faces: [{ id: "armstrong", left: 120, top: 180, scale: 1 }],
  },
  {
    id: "tiny-thumbnail",
    description: "avatar at 22% scale - a ~47px face, near the model's floor",
    width: 1280,
    height: 800,
    style: "light",
    panels: true,
    faces: [{ id: "armstrong", left: 640, top: 300, scale: 0.22 }],
  },
  {
    id: "id-card",
    description: "photo-ID style portrait, large, centred",
    width: 1024,
    height: 768,
    style: "grey",
    panels: false,
    faces: [{ id: "chawla", left: 400, top: 200, scale: 1.4 }],
  },
  {
    id: "dark-dashboard",
    description: "avatar on a dark dashboard",
    width: 1280,
    height: 800,
    style: "dark",
    panels: true,
    faces: [{ id: "jemison", left: 900, top: 120, scale: 1 }],
  },
  {
    id: "team-row",
    description: "three team members in a row - the multi-face case",
    width: 1280,
    height: 800,
    style: "light",
    panels: false,
    faces: [
      { id: "ride", left: 120, top: 260, scale: 0.9 },
      { id: "bluford", left: 520, top: 260, scale: 0.9 },
      { id: "jemison", left: 900, top: 260, scale: 0.9 },
    ],
  },
  {
    id: "two-column",
    description: "two faces at different scales in one view",
    width: 1280,
    height: 800,
    style: "light",
    panels: true,
    faces: [
      { id: "armstrong", left: 80, top: 100, scale: 1.2 },
      { id: "chawla", left: 800, top: 420, scale: 0.7 },
    ],
  },
  {
    id: "top-edge",
    description: "face against the top edge of the viewport",
    width: 1280,
    height: 800,
    style: "light",
    panels: true,
    faces: [{ id: "bluford", left: 500, top: 0, scale: 1 }],
  },
  {
    id: "bottom-right",
    description: "face in the bottom-right corner",
    width: 1280,
    height: 800,
    style: "grey",
    panels: true,
    faces: [{ id: "ride", left: 1000, top: 480, scale: 1 }],
  },
  {
    id: "video-call",
    description: "two-participant call layout on a dark background",
    width: 1280,
    height: 720,
    style: "dark",
    panels: false,
    faces: [
      { id: "jemison", left: 200, top: 200, scale: 1.3 },
      { id: "armstrong", left: 800, top: 220, scale: 1.1 },
    ],
  },
  {
    id: "thumbnail-grid",
    description: "three quarter-size thumbnails, the hardest scale in the set",
    width: 1280,
    height: 800,
    style: "light",
    panels: true,
    faces: [
      { id: "chawla", left: 200, top: 200, scale: 0.35 },
      { id: "ride", left: 600, top: 200, scale: 0.35 },
      { id: "bluford", left: 1000, top: 200, scale: 0.35 },
    ],
  },
  {
    id: "narrow-viewport",
    description: "single face in a phone-width viewport",
    width: 480,
    height: 900,
    style: "light",
    panels: true,
    faces: [{ id: "jemison", left: 140, top: 300, scale: 0.9 }],
  },
  {
    id: "wide-viewport",
    description: "single face in an ultrawide viewport, where letterboxing costs most",
    width: 1920,
    height: 600,
    style: "light",
    panels: true,
    faces: [{ id: "armstrong", left: 1400, top: 200, scale: 1 }],
  },
  {
    id: "kyc-upload",
    description: "large document-upload preview",
    width: 1024,
    height: 900,
    style: "grey",
    panels: false,
    faces: [{ id: "bluford", left: 300, top: 250, scale: 1.6 }],
  },
  {
    id: "blurred-dark",
    description: "half-size, blurred face on a dark background",
    width: 1280,
    height: 800,
    style: "dark",
    panels: true,
    faces: [{ id: "ride", left: 300, top: 400, scale: 0.5, blur: 3 }],
  },
  {
    id: "occluded-face",
    description: "lower third of the face covered by a caption bar",
    width: 1280,
    height: 800,
    style: "light",
    panels: true,
    faces: [{ id: "chawla", left: 560, top: 380, scale: 0.8, occludeBottom: 0.33 }],
  },
  {
    id: "left-edge",
    description: "face clipped by the left edge of the viewport",
    width: 1280,
    height: 800,
    style: "light",
    panels: false,
    faces: [{ id: "jemison", left: 0, top: 350, scale: 1.1 }],
  },
  {
    id: "stacked-pair",
    description: "two faces stacked vertically, close together",
    width: 900,
    height: 900,
    style: "light",
    panels: true,
    faces: [
      { id: "armstrong", left: 340, top: 120, scale: 0.9 },
      { id: "chawla", left: 340, top: 480, scale: 0.9 },
    ],
  },
  {
    id: "small-dark-pair",
    description: "two half-size faces on a dark dashboard",
    width: 1280,
    height: 800,
    style: "dark",
    panels: true,
    faces: [
      { id: "bluford", left: 240, top: 240, scale: 0.5 },
      { id: "ride", left: 840, top: 520, scale: 0.5 },
    ],
  },
  {
    id: "large-portrait",
    description: "a single face filling most of the frame",
    width: 800,
    height: 800,
    style: "grey",
    panels: false,
    faces: [{ id: "ride", left: 180, top: 120, scale: 2 }],
  },
  {
    id: "no-faces",
    description: "a page with no face at all - the false-positive control",
    width: 1280,
    height: 800,
    style: "light",
    panels: true,
    faces: [],
  },
];

/** Builds every scene. Deterministic: same pixels, same labels, every run. */
export function buildFaceScenes(): FaceScene[] {
  return SPECS.map((spec, index) => {
    const image = blankScene(spec.width, spec.height, 1000 + index * 7, spec.style);
    if (spec.panels) drawPanels(image, 5000 + index * 13);

    const faces = spec.faces.map((placement) => {
      const bbox = paste(image, face(placement.id), placement.left, placement.top, placement.scale);
      if (placement.blur) blurRegion(image, bbox, placement.blur);
      if (placement.occludeBottom) occludeBottom(image, bbox, placement.occludeBottom);
      return { bbox, source: placement.id };
    });

    return { id: spec.id, description: spec.description, image, faces };
  });
}
