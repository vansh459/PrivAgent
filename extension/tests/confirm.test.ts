import { afterEach, describe, expect, it } from "vitest";
import { confirmAction } from "../src/content/confirm";
import type { Action } from "../src/schemas/screenState";

/**
 * The prompt renders into a *closed* shadow root so the host page cannot read it or
 * synthesize a click on "Allow". That also means these tests cannot query inside it -
 * which is the point. Behaviour is asserted through the host element and the keyboard
 * interface, exactly as an outside observer (or an attacking page) would see it.
 */

function action(overrides: Partial<Action> = {}): Action {
  return {
    action: "navigate",
    target_id: null,
    params: { url: "/elsewhere" },
    confidence: 0.9,
    risk: "high",
    explanation: "Taking you somewhere else",
    reasoning_trace_id: "trace_1",
    ...overrides,
  };
}

function host(): HTMLElement | null {
  return document.getElementById("privagent-confirm-host");
}

function press(key: string, init: KeyboardEventInit = {}): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

describe("confirmAction", () => {
  afterEach(() => host()?.remove());

  it("mounts a prompt the page cannot read into", async () => {
    const pending = confirmAction(action(), "high");

    const mounted = host();
    expect(mounted).not.toBeNull();
    // A closed shadow root reports null to anything outside it, including the page.
    expect(mounted!.shadowRoot).toBeNull();

    press("Escape");
    await pending;
  });

  it("denies on Escape and removes the prompt", async () => {
    const pending = confirmAction(action(), "high");
    press("Escape");

    await expect(pending).resolves.toBe(false);
    expect(host()).toBeNull();
  });

  it("approves only on Ctrl+Enter, not a bare Enter", async () => {
    const pending = confirmAction(action(), "medium");

    press("Enter");
    expect(host()).not.toBeNull();

    press("Enter", { ctrlKey: true });
    await expect(pending).resolves.toBe(true);
    expect(host()).toBeNull();
  });

  it("ignores unrelated keys", async () => {
    const pending = confirmAction(action(), "high");

    press("a");
    press("Tab");
    expect(host()).not.toBeNull();

    press("Escape");
    await expect(pending).resolves.toBe(false);
  });

  it("replaces an earlier prompt rather than stacking prompts", async () => {
    const first = confirmAction(action(), "high");
    const second = confirmAction(action({ action: "type", params: { text: "x" } }), "medium");

    expect(document.querySelectorAll("#privagent-confirm-host")).toHaveLength(1);

    press("Escape");
    await expect(second).resolves.toBe(false);
    // The first prompt was detached without settling; its listener is gone.
    expect(host()).toBeNull();
    void first;
  });

  it("stops listening once settled", async () => {
    const pending = confirmAction(action(), "high");
    press("Escape");
    await pending;

    // A second Escape after settling must not throw or resurrect anything.
    expect(() => press("Escape")).not.toThrow();
    expect(host()).toBeNull();
  });
});
