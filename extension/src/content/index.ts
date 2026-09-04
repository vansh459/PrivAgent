import browser from "webextension-polyfill";
import { walkInteractiveDom } from "./domWalker";

const elements = walkInteractiveDom();

void browser.runtime
  .sendMessage({ type: "privagent.content-ready", elementCount: elements.length })
  .catch(() => {
    // The background service worker may not be available during browser startup.
  });
