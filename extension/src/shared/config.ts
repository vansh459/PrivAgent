import browser from "webextension-polyfill";

/** Local-by-default: the reasoner is expected to run on the user's own machine. */
export const DEFAULT_SERVER_URL = "http://127.0.0.1:8000";

const STORAGE_KEY = "privagent.serverUrl";

export async function getServerUrl(): Promise<string> {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    const value = stored[STORAGE_KEY];
    return typeof value === "string" && value.length > 0 ? value : DEFAULT_SERVER_URL;
  } catch {
    return DEFAULT_SERVER_URL;
  }
}

export async function setServerUrl(url: string): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: url });
}
