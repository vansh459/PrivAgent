import browser from "webextension-polyfill";

browser.runtime.onInstalled.addListener(() => {
  console.info("PrivAgent service worker installed.");
});
