import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";

/**
 * One config, two extension targets. The manifest is imported *after* the target env var
 * is set so `manifest.config.ts` can branch on it, and each target gets its own outDir
 * so both builds can exist side by side for cross-browser testing.
 */
export default defineConfig(async ({ mode }) => {
  const target = mode === "firefox" ? "firefox" : "chrome";
  process.env.PRIVAGENT_TARGET = target;

  const { default: manifest } = await import("./manifest.config.ts");

  return {
    plugins: [crx({ manifest, browser: target === "firefox" ? "firefox" : "chrome" })],
    build: {
      outDir: `dist/${target}`,
      emptyOutDir: true,
      rollupOptions: {
        // The offscreen document is created at runtime by `chrome.offscreen`, so no
        // manifest field points at it and CRXJS would not otherwise emit it.
        input: { offscreen: "src/ui/offscreen.html" },
      },
    },
    server: { port: 5173, strictPort: true },
  };
});
