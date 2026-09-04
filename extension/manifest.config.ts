import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "PrivAgent",
  version: "0.1.0",
  description: "Privacy-preserving browser agent",
  action: {
    default_popup: "src/ui/popup.html",
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
    },
  ],
  permissions: ["storage", "activeTab"],
  host_permissions: ["<all_urls>"],
  browser_specific_settings: {
    gecko: {
      id: "privagent@example.invalid",
      strict_min_version: "121.0",
    },
  },
});
