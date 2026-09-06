import { defineManifest } from "@crxjs/vite-plugin";

/**
 * Entry files are named `service-worker.ts` and `content-script.ts`, not `index.ts`.
 * Two entries with the same basename collide in the emitted chunk names, and the
 * generated service-worker loader ends up importing the content script's chunk - the
 * background listener is then simply never registered, with no build error.
 *
 * Chrome and Firefox disagree on exactly one MV3 field that matters to us: Chrome
 * requires `background.service_worker`, while Firefox only supports `background.scripts`
 * with an event page. Everything else is shared, so the manifest is built per target and
 * selected with `vite build --mode firefox`.
 */
const isFirefox = process.env.PRIVAGENT_TARGET === "firefox";

const background = isFirefox
  ? { scripts: ["src/background/service-worker.ts"], type: "module" as const }
  : { service_worker: "src/background/service-worker.ts", type: "module" as const };

export default defineManifest({
  manifest_version: 3,
  name: "PrivAgent",
  // Kept in step with `package.json` by hand, and asserted by
  // `scripts/verify-manifests.mjs` so the two cannot drift apart silently - a packaged
  // `.xpi` is named from the manifest, not from the package.
  version: "0.3.0",
  description: "Privacy-preserving browser agent with on-device perception and redaction",
  action: {
    default_popup: "src/ui/popup.html",
  },
  // Vite only emits an HTML entry that something references; the diagnostics page is
  // opened from the popup, so it is declared here to be part of the build.
  options_page: "src/ui/diagnostics.html",
  /**
   * Local inference runs in the content script's isolated world, alongside the DOM walker
   * that produces the other half of the Screen State. A content script fetches
   * extension-owned files only if they are declared here, so the ONNX/Tesseract cores,
   * the face model and the OCR language data all have to be web-accessible.
   *
   * The cost is that a page can probe for these URLs and learn the extension is
   * installed. That is accepted knowingly: the alternative is fetching the same files
   * from a CDN, which tells a third party the same thing *and* when it happened.
   */
  web_accessible_resources: [
    {
      resources: ["vendor/ort/*", "vendor/tesseract/*", "models/*", "tessdata/*"],
      matches: ["<all_urls>"],
    },
  ],
  background,
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/content-script.ts"],
      run_at: "document_idle",
    },
  ],
  // `wasm-unsafe-eval` is required for ONNX Runtime Web and the Tesseract WASM core to
  // instantiate at all under MV3. Without it local inference cannot start.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  // `tabs` is what makes `tabs.captureVisibleTab` available to the background worker;
  // `activeTab` alone cannot capture.
  // `offscreen` is Chrome-only and is what lets local vision run in an extension-origin
  // document: a service worker cannot create a Worker or a canvas, and a content script
  // is stuck on the visited site's origin. Firefox's MV3 background is an event page with
  // a DOM, so it hosts the same module itself and needs no such permission.
  permissions: isFirefox
    ? ["storage", "activeTab", "tabs"]
    : ["storage", "activeTab", "tabs", "offscreen"],
  host_permissions: ["<all_urls>"],
  ...(isFirefox
    ? {
        browser_specific_settings: {
          gecko: {
            id: "privagent@example.invalid",
            strict_min_version: "128.0",
            // Firefox is beginning to require an explicit data-collection declaration, and
            // for this extension the answer is the whole point of the project: none. The
            // screen is perceived, redacted and acted on locally; the only thing that
            // leaves the machine is a Set-of-Mark payload with every detected value
            // replaced by a token, sent to a reasoner the user chooses and can run on
            // their own hardware.
            data_collection_permissions: { required: ["none"] },
          },
        },
      }
    : {}),
});
