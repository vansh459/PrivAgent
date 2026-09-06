/**
 * Detects automation challenges so the agent can stop - and only stop.
 *
 * Policy, stated where the code lives: PrivAgent treats a bot check as a hard boundary.
 * When a page presents reCAPTCHA, hCaptcha, Turnstile, a Cloudflare/Akamai challenge
 * interstitial or an "unusual traffic" wall, the loop terminates with
 * `blocked: bot_detection` and tells the user why. Nothing in this module - or anywhere
 * else in this codebase - attempts to solve, bypass, delay past, or otherwise defeat a
 * challenge. A site that says "no robots" is answered with "understood".
 *
 * Detection is deliberately conservative: it looks for the concrete artifacts the
 * challenge vendors actually inject (their iframes and containers) and for whole-page
 * interstitial markers, not for the word "captcha" anywhere in prose - a news article
 * about CAPTCHAs is not a challenge.
 */

export interface BotBlockDetection {
  blocked: boolean;
  /** Which artifact matched, for the audit trail. Never page content. */
  marker?: string;
}

/** Challenge-vendor artifacts: iframe sources and well-known widget containers. */
const CHALLENGE_IFRAMES: readonly { marker: string; pattern: RegExp }[] = [
  { marker: "recaptcha", pattern: /(?:google\.com\/recaptcha|recaptcha\.net)/i },
  { marker: "hcaptcha", pattern: /hcaptcha\.com/i },
  { marker: "turnstile", pattern: /challenges\.cloudflare\.com/i },
  { marker: "arkose", pattern: /(?:arkoselabs|funcaptcha)\.com/i },
];

const CHALLENGE_SELECTORS: readonly { marker: string; selector: string }[] = [
  { marker: "recaptcha", selector: ".g-recaptcha[data-sitekey], #recaptcha-anchor" },
  { marker: "hcaptcha", selector: ".h-captcha[data-sitekey]" },
  { marker: "turnstile", selector: ".cf-turnstile[data-sitekey]" },
  // Cloudflare's full-page challenge shell (also carries the page title checked below).
  {
    marker: "cloudflare-challenge",
    selector: "#challenge-form, #challenge-running, #cf-challenge-running",
  },
  // Akamai's bot manager interstitial.
  { marker: "akamai-challenge", selector: "#sec-cpt-if, iframe[src*='akamai']" },
  // PerimeterX / HUMAN block page.
  { marker: "px-challenge", selector: "#px-captcha" },
];

/**
 * Whole-page interstitial titles. Only consulted when the document is essentially a
 * challenge shell; matching titles on ordinary pages would flag articles about bots.
 */
const INTERSTITIAL_TITLES: readonly { marker: string; pattern: RegExp }[] = [
  {
    marker: "cloudflare-interstitial",
    pattern: /just a moment|attention required|checking your browser/i,
  },
  { marker: "generic-interstitial", pattern: /verify you are (?:a )?human|are you a robot/i },
  { marker: "rate-interstitial", pattern: /unusual traffic|access denied.*automated/i },
];

/** True when the page is mostly challenge, not content - few elements, tiny text. */
function looksLikeInterstitial(root: Document): boolean {
  const body = root.body as (HTMLElement & { innerText?: string }) | null;
  // `textContent` fallback: jsdom-hosted tests have no layout, hence no `innerText`.
  const textLength = (body?.innerText ?? body?.textContent ?? "").trim().length;
  const elementCount = body?.querySelectorAll("*").length ?? 0;
  return textLength < 2_000 && elementCount < 400;
}

/** Scans the live document for challenge artifacts. Read-only; touches nothing. */
export function detectBotBlock(root: Document = document): BotBlockDetection {
  for (const { marker, selector } of CHALLENGE_SELECTORS) {
    if (root.querySelector(selector)) return { blocked: true, marker };
  }

  for (const frame of root.querySelectorAll("iframe[src]")) {
    const src = frame.getAttribute("src") ?? "";
    for (const { marker, pattern } of CHALLENGE_IFRAMES) {
      if (pattern.test(src)) return { blocked: true, marker };
    }
  }

  if (looksLikeInterstitial(root)) {
    const title = root.title ?? "";
    for (const { marker, pattern } of INTERSTITIAL_TITLES) {
      if (pattern.test(title)) return { blocked: true, marker };
    }
  }

  return { blocked: false };
}
