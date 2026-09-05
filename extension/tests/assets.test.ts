import { describe, expect, it, vi } from "vitest";

const getURL = vi.fn((path: string) => `chrome-extension://abc/${path}`);
vi.stubGlobal("chrome", { runtime: { getURL } });

const { assetUrl, hasExtensionOrigin, LOCAL_ASSETS } = await import("../src/shared/assets");

describe("local asset resolution", () => {
  it("resolves every bundled asset against the extension origin", () => {
    for (const path of Object.values(LOCAL_ASSETS)) {
      expect(assetUrl(path)).toBe(`chrome-extension://abc/${path}`);
    }
    expect(hasExtensionOrigin()).toBe(true);
  });

  it("returns the bare path when there is no extension runtime", () => {
    getURL.mockImplementationOnce(() => {
      throw new Error("not an extension context");
    });
    expect(assetUrl("models/x.onnx")).toBe("models/x.onnx");
  });

  it("keeps directory assets trailing-slashed, which is what the loaders require", () => {
    for (const path of [
      LOCAL_ASSETS.ortWasmDir,
      LOCAL_ASSETS.tesseractCoreDir,
      LOCAL_ASSETS.tessdataDir,
    ]) {
      expect(path.endsWith("/")).toBe(true);
    }
  });

  it("points at no remote origin at all", () => {
    for (const path of Object.values(LOCAL_ASSETS)) {
      expect(path).not.toMatch(/^https?:/);
    }
  });
});
