import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePng, encodeRgbaPng, type RgbaImage } from "./helpers/png";

const datasetDir = resolve(import.meta.dirname, "..", "..", "tests", "dataset", "faces");

describe("PNG codec", () => {
  it("decodes the committed dataset images at their manifest dimensions", () => {
    const manifest = JSON.parse(readFileSync(resolve(datasetDir, "sources.json"), "utf8")) as {
      faces: { file: string; width: number; height: number }[];
    };
    expect(manifest.faces).toHaveLength(5);

    for (const face of manifest.faces) {
      const image = decodePng(readFileSync(resolve(datasetDir, face.file)));
      expect([image.width, image.height], face.file).toEqual([face.width, face.height]);
      expect(image.data).toHaveLength(face.width * face.height * 4);
      // Opaque, and not a uniform block - i.e. actual picture data came back.
      expect(image.data[3]).toBe(255);
      expect(new Set(image.data.slice(0, 4000)).size).toBeGreaterThan(20);
    }
  });

  it("round-trips an image through encode and decode unchanged", () => {
    const source: RgbaImage = {
      width: 7,
      height: 5,
      data: new Uint8ClampedArray(7 * 5 * 4).map((_, index) => (index * 37) % 256),
    };
    const decoded = decodePng(encodeRgbaPng(source));

    expect(decoded.width).toBe(7);
    expect(decoded.height).toBe(5);
    expect(Array.from(decoded.data)).toEqual(Array.from(source.data));
  });

  it("rejects a file that is not a PNG", () => {
    expect(() => decodePng(Buffer.from("not a png at all"))).toThrow(/Not a PNG/);
  });
});
