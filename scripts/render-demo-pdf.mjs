import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Renders docs/demo-presentation.html to docs/DEMO_PRESENTATION.pdf.
 * Re-run after editing the HTML:  node scripts/render-demo-pdf.mjs
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Playwright is a dev dependency of the extension package, not the root.
const require = createRequire(resolve(root, "extension", "package.json"));
const { chromium } = require("@playwright/test");
const source = resolve(root, "docs", "demo-presentation.html");
const target = resolve(root, "docs", "DEMO_PRESENTATION.pdf");

// Same browser-discovery the e2e harness uses (extension/e2e/harness.ts): Playwright's
// own chromium is not downloaded on this machine, so fall back to installed Edge/Chrome.
function channelOverride() {
  if (existsSync(chromium.executablePath())) return undefined;
  for (const [channel, path] of [
    ["msedge", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"],
    ["msedge", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"],
    ["chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe"],
  ]) {
    if (existsSync(path)) return channel;
  }
  return undefined;
}

const channel = channelOverride();
const browser = await chromium.launch(channel ? { channel } : {});
const page = await browser.newPage();
await page.goto(pathToFileURL(source).href, { waitUntil: "networkidle" });
await page.pdf({
  path: target,
  format: "A4",
  printBackground: true,
  margin: { top: "0", bottom: "0", left: "0", right: "0" },
});
await browser.close();
console.log(`Wrote ${target}`);
