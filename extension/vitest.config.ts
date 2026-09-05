import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        // Generated from server/app/schemas.py; covered by the schema drift check.
        "src/schemas/generated.ts",
        // Entry points exercised through the browser (e2e), not jsdom.
        "src/background/service-worker.ts",
        "src/ui/popup.ts",
        "src/ui/diagnostics.ts",
        "src/vision/offscreen.ts",
      ],
      // A ratchet, not an aspiration: these sit just below the measured numbers, so any
      // regression fails CI. Raise them as Stage 2 brings the vision modules under test.
      thresholds: {
        statements: 86,
        branches: 75,
        functions: 80,
        lines: 89,
      },
    },
  },
});
