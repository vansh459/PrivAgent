import browser from "webextension-polyfill";

const status = document.querySelector<HTMLParagraphElement>("#status");

if (status) {
  browser.runtime
    .getPlatformInfo()
    .then(({ os }) => {
      status.textContent = `Extension scaffold loaded on ${os}.`;
    })
    .catch(() => {
      status.textContent = "Extension scaffold loaded.";
    });
}
