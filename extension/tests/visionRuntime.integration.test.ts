import * as ort from "onnxruntime-web";
import { describe, expect, it } from "vitest";
import { createVisionSession } from "../src/content/visionRuntime";
import { IDENTITY_PROBE_MODEL } from "../src/models/identityProbeModel";

describe("local ONNX vision runtime", () => {
  it("executes the bundled probe model through the WASM fallback", async () => {
    const { backend, session } = await createVisionSession(IDENTITY_PROBE_MODEL);
    const output = await session.run({ input: new ort.Tensor("float32", [42], [1]) });

    expect(backend).toBe("wasm");
    expect(output.output.data).toEqual(new Float32Array([42]));
  });
});
