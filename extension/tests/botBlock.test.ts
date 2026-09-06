import { beforeEach, describe, expect, it } from "vitest";
import { detectBotBlock } from "../src/content/botBlock";

/**
 * One fixture per challenge family the detector claims to recognise, plus the negatives
 * that keep it honest: a news article ABOUT captchas, and a rich page whose title
 * happens to contain interstitial words, must not be flagged.
 */

describe("bot-block detection", () => {
  beforeEach(() => {
    document.title = "";
    document.body.innerHTML = "";
  });

  it("recognises a reCAPTCHA widget", () => {
    document.body.innerHTML = `<form><div class="g-recaptcha" data-sitekey="k"></div></form>`;
    expect(detectBotBlock()).toEqual({ blocked: true, marker: "recaptcha" });
  });

  it("recognises a reCAPTCHA iframe", () => {
    document.body.innerHTML = `<iframe src="https://www.google.com/recaptcha/api2/anchor?ar=1"></iframe>`;
    expect(detectBotBlock()).toEqual({ blocked: true, marker: "recaptcha" });
  });

  it("recognises an hCaptcha widget", () => {
    document.body.innerHTML = `<div class="h-captcha" data-sitekey="10000000-ffff"></div>`;
    expect(detectBotBlock()).toEqual({ blocked: true, marker: "hcaptcha" });
  });

  it("recognises a Cloudflare Turnstile widget and its challenge iframe", () => {
    document.body.innerHTML = `<div class="cf-turnstile" data-sitekey="0x4AAA"></div>`;
    expect(detectBotBlock().marker).toBe("turnstile");

    document.body.innerHTML = `<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/ov2"></iframe>`;
    expect(detectBotBlock().marker).toBe("turnstile");
  });

  it("recognises a Cloudflare challenge interstitial", () => {
    document.title = "Just a moment...";
    document.body.innerHTML = `<div id="challenge-running"></div><p>Checking your browser</p>`;
    expect(detectBotBlock().blocked).toBe(true);
  });

  it("recognises a bare 'verify you are human' interstitial by title on a thin page", () => {
    document.title = "Verify you are human";
    document.body.innerHTML = `<p>Please complete the check to continue.</p>`;
    expect(detectBotBlock()).toEqual({ blocked: true, marker: "generic-interstitial" });
  });

  it("recognises a PerimeterX block page", () => {
    document.body.innerHTML = `<div id="px-captcha"></div>`;
    expect(detectBotBlock().marker).toBe("px-challenge");
  });

  it("does not flag an article about CAPTCHAs", () => {
    document.title = "How CAPTCHAs work - Tech Weekly";
    document.body.innerHTML = `<article><h1>How CAPTCHAs work</h1>${"<p>Long prose about challenges and robots. </p>".repeat(80)}</article>`;
    expect(detectBotBlock().blocked).toBe(false);
  });

  it("does not flag a rich page whose title mentions robots", () => {
    document.title = "Are you a robot? The philosophy of automation";
    document.body.innerHTML = `<main>${"<section><p>Chapter text ...</p></section>".repeat(150)}</main>`;
    expect(detectBotBlock().blocked).toBe(false);
  });

  it("does not flag an ordinary portal page", () => {
    document.title = "Expenditure Portal";
    document.body.innerHTML = `<a href="#d">Download report</a><button>Cancel</button>`;
    expect(detectBotBlock().blocked).toBe(false);
  });
});
