import { beforeEach, describe, expect, it } from "vitest";
import { isCredentialField, perceiveDom, walkInteractiveDom } from "../src/content/domWalker";
import { prepareContext } from "../src/content/pipeline";
import { setBoundingBox, stubLayout } from "./helpers/layout";

/**
 * Regression suite for a confirmed leak: `elementText()` used to return `element.value`
 * for any `<input>`, including `type="password"`, and DOM elements were hardcoded
 * `sensitive: false`, so a typed password was serialized into the server payload.
 *
 * These tests fail if a credential value can reach a transmitted context by any route.
 */

const SECRET = "Hunter2SuperSecret";

describe("credential fields are excluded at extraction", () => {
  beforeEach(() => stubLayout());

  it.each([
    ["a password input", `<input id="f" type="password" />`],
    ["a current-password field", `<input id="f" autocomplete="current-password" />`],
    ["a new-password field", `<input id="f" autocomplete="new-password" />`],
    ["a one-time code field", `<input id="f" autocomplete="one-time-code" />`],
    ["a card number field", `<input id="f" autocomplete="cc-number" />`],
    ["a card security code field", `<input id="f" autocomplete="cc-csc" />`],
    ["an explicitly marked field", `<input id="f" data-privagent-sensitive="true" />`],
  ])("never perceives %s", (_case, html) => {
    document.body.innerHTML = html;
    const field = document.querySelector<HTMLInputElement>("#f")!;
    field.value = SECRET;
    setBoundingBox(field, 0, 0, 200, 30);

    expect(isCredentialField(field)).toBe(true);
    expect(walkInteractiveDom()).toEqual([]);
  });

  it("keeps a password field out of the transmitted context entirely", async () => {
    document.body.innerHTML = `
      <input id="user" name="username" placeholder="Username" />
      <input id="pass" type="password" name="password" />
      <button id="go">Log in</button>`;
    const password = document.querySelector<HTMLInputElement>("#pass")!;
    password.value = SECRET;
    for (const id of ["user", "pass", "go"]) {
      setBoundingBox(document.querySelector<HTMLElement>(`#${id}`)!, 0, 0, 200, 30);
    }

    const elements = walkInteractiveDom();
    const { context } = await prepareContext("log in", elements);
    const payload = JSON.stringify(context);

    expect(payload).not.toContain(SECRET);
    expect(payload).not.toContain("password");
    expect(context.elements.map((element) => element.text)).toEqual(["Username", "Log in"]);
  });
});

describe("no input value is ever read, credential or not", () => {
  beforeEach(() => stubLayout());

  it("describes an ordinary text field by its label, not its contents", () => {
    document.body.innerHTML = `<label for="city">Home city</label><input id="city" name="city" />`;
    const input = document.querySelector<HTMLInputElement>("#city")!;
    input.value = "Bengaluru";
    setBoundingBox(input, 0, 0, 200, 30);

    const [element] = walkInteractiveDom();

    expect(element?.text).toBe("Home city");
    expect(JSON.stringify(element)).not.toContain("Bengaluru");
  });

  it("does not expose credential fields through the live element refs either", () => {
    document.body.innerHTML = `<input id="pass" type="password" />`;
    setBoundingBox(document.querySelector<HTMLElement>("#pass")!, 0, 0, 200, 30);

    expect([...perceiveDom().refs.values()]).toEqual([]);
  });
});
