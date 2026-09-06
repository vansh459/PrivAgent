import tokens from "../ui/tokens.css?inline";
import { LOCAL_ASSETS, assetUrl } from "../shared/assets";
import type { Action, RiskTier } from "../schemas/screenState";

/**
 * In-page confirmation gate for medium- and high-risk actions.
 *
 * Rendered into a closed shadow root so the host page's stylesheet cannot restyle or hide
 * the prompt, and so the page cannot read its contents. That isolation is the reason this
 * file has to carry its own stylesheet - and the reason it imports the *same* token file
 * the extension's pages use rather than restating the values. There is one design system
 * and one copy of it; this surface just has to smuggle it across an origin boundary.
 */

const HOST_ID = "privagent-confirm-host";

/**
 * The shared tokens, re-scoped for a shadow root.
 *
 * Two edits, both forced by the boundary this card sits on. `:root` matches the document
 * element, which is outside this tree, so the custom properties would never reach it -
 * `:host` is the same declaration addressed to the shadow host, and it also beats anything
 * the page tries to inherit in. And `@font-face` is ignored inside shadow DOM entirely, so
 * the rule is stripped here and the face is registered on the document instead (see
 * `loadFont`). Everything else is the product's token file, byte for byte.
 */
function tokenStyles(): string {
  return tokens.replace(/@font-face\s*\{[^}]*\}/g, "").replace(/:root\b/g, ":host");
}

let fontRequested = false;

/**
 * Registers the interface font on the visited page's document.
 *
 * A shadow tree draws from the document's font set, so there is nowhere else to put it.
 * The side effect is that the page gains an "Inter" family it did not ask for, which is a
 * smaller disclosure than the one the manifest already accepts knowingly - a page can
 * probe for the extension's web-accessible URLs regardless. Failure is silent: without the
 * face the card renders in the system stack, which is a worse-looking prompt and not a
 * broken one.
 */
function loadFont(): void {
  if (fontRequested) return;
  fontRequested = true;
  try {
    const face = new FontFace("Inter", `url(${assetUrl(LOCAL_ASSETS.uiFont)}) format("woff2")`, {
      weight: "100 900",
      display: "swap",
    });
    void face.load().then((loaded) => document.fonts.add(loaded));
  } catch {
    // No FontFace API, or no extension origin. The fallback stack is already in the token.
  }
}

function describe(action: Action): string {
  switch (action.action) {
    case "click":
      return `Click ${action.target_id}`;
    case "type":
      return `Type into ${action.target_id}`;
    case "scroll":
      return `Scroll the page by ${action.params?.top ?? 0}px`;
    case "navigate":
      return `Navigate to ${action.params?.url ?? "an unspecified URL"}`;
    case "none":
      return "Take no action";
    case "done":
      return `Finish the task: ${action.params?.summary ?? "completed"}`;
    case "blocked":
      return `Stop: ${action.params?.reason ?? "cannot proceed"}`;
  }
}

export function confirmAction(action: Action, risk: RiskTier): Promise<boolean> {
  document.getElementById(HOST_ID)?.remove();
  loadFont();

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;inset:auto 16px 16px auto;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });

  root.innerHTML = `
    <style>
      ${tokenStyles()}

      /*
       * GLASS, use 3 of 3 - and the one that earns it most. This card floats above a page
       * nobody has seen: the blur is what separates it from whatever is underneath, and the
       * 0.82 fill is why the text still clears contrast when "underneath" turns out to be a
       * photograph. Where backdrop-filter is unavailable the fill goes fully opaque, because
       * a translucent card over an unknown background is a legibility gamble.
       */
      .card {
        box-sizing: border-box;
        width: min(var(--width-prompt), calc(100vw - var(--space-8)));
        padding: var(--space-4);
        border: var(--border-width) solid var(--glass-border);
        border-left: var(--space-1) solid var(--risk-colour);
        border-radius: var(--radius-lg);
        background: var(--glass-bg);
        backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
        -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
        box-shadow: var(--glass-shadow);
        color: var(--fg);
        font-family: var(--font-sans);
        font-size: var(--text-body);
        line-height: var(--leading-body);
      }

      /* A 1px blur here is a support probe, not a design value. */
      @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        .card { background: var(--surface); }
      }

      .risk {
        margin: 0;
        color: var(--risk-colour);
        font-weight: var(--weight-semibold);
        letter-spacing: var(--tracking-wide);
        line-height: var(--leading-heading);
        text-transform: uppercase;
      }

      .what {
        margin: var(--space-2) 0 var(--space-1);
        font-weight: var(--weight-semibold);
      }

      .why {
        margin: 0 0 var(--space-4);
        color: var(--fg-muted);
      }

      .row {
        display: flex;
        gap: var(--space-2);
        justify-content: flex-end;
      }

      button {
        height: var(--control-height);
        padding: 0 var(--space-4);
        border: var(--border-width) solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--surface);
        color: var(--fg);
        font: inherit;
        font-weight: var(--weight-medium);
        cursor: pointer;
        transition:
          background-color var(--duration-fast) var(--ease),
          border-color var(--duration-fast) var(--ease),
          box-shadow var(--duration-fast) var(--ease),
          transform var(--duration-fast) var(--ease);
      }

      button:hover { border-color: var(--border-strong); background: var(--neutral-100); }
      button:active { transform: translateY(var(--border-width)); }
      button:focus-visible { outline: none; box-shadow: var(--ring); }

      /*
       * CLAY, use 4 of 4. Allow is the one action this card exists to offer, so it is the
       * one that is tactile. Deny stays flat - the asymmetry is the same one the keyboard
       * has, where Escape refuses and only Ctrl+Enter agrees.
       */
      .go {
        border: none;
        border-radius: var(--radius-md);
        background: var(--accent-500);
        color: var(--accent-fg);
        font-weight: var(--weight-semibold);
        box-shadow: var(--clay-shadow);
      }

      .go:hover { background: var(--accent-600); box-shadow: var(--clay-shadow-hover); }
      .go:active { transform: translateY(var(--border-width)); box-shadow: var(--clay-shadow-pressed); }

      .keys {
        margin: var(--space-3) 0 0;
        color: var(--fg-subtle);
      }
    </style>
    <div class="card" role="alertdialog" aria-label="PrivAgent action confirmation">
      <p class="risk"></p>
      <p class="what"></p>
      <p class="why"></p>
      <div class="row">
        <button class="no" type="button">Deny</button>
        <button class="go" type="button">Allow</button>
      </div>
      <p class="keys">Esc to deny · Ctrl+Enter to allow</p>
    </div>`;

  // The risk tier picks one semantic token; nothing else about the card changes with it.
  const card = root.querySelector<HTMLElement>(".card")!;
  card.style.setProperty("--risk-colour", risk === "high" ? "var(--danger)" : "var(--warning)");

  // textContent, never innerHTML: the explanation is model output, not trusted markup.
  root.querySelector<HTMLElement>(".risk")!.textContent = `${risk} risk · confirmation required`;
  root.querySelector<HTMLElement>(".what")!.textContent = describe(action);
  root.querySelector<HTMLElement>(".why")!.textContent = action.explanation;

  document.documentElement.append(host);

  return new Promise<boolean>((resolve) => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") settle(false);
      if (event.key === "Enter" && event.ctrlKey) settle(true);
    };

    const settle = (approved: boolean) => {
      document.removeEventListener("keydown", onKeyDown, true);
      host.remove();
      resolve(approved);
    };

    root.querySelector<HTMLButtonElement>(".go")!.addEventListener("click", () => settle(true));
    root.querySelector<HTMLButtonElement>(".no")!.addEventListener("click", () => settle(false));

    // Keyboard escape hatch: Escape denies, Ctrl+Enter approves. Deliberately asymmetric -
    // dismissing must be the easy, reflexive action; approving must be deliberate.
    document.addEventListener("keydown", onKeyDown, true);
    root.querySelector<HTMLButtonElement>(".no")!.focus();
  });
}
