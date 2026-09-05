import type { Action, RiskTier } from "../schemas/screenState";

/**
 * In-page confirmation gate for medium- and high-risk actions.
 *
 * Rendered into a closed shadow root so the host page's stylesheet cannot restyle or
 * hide the prompt, and so the page cannot read its contents.
 */

const HOST_ID = "privagent-confirm-host";

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
  }
}

export function confirmAction(action: Action, risk: RiskTier): Promise<boolean> {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;inset:auto 16px 16px auto;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });

  root.innerHTML = `
    <style>
      .card { font: 13px/1.5 system-ui, sans-serif; background: #fff; color: #111;
              border: 1px solid #d0d0d0; border-left: 4px solid ${risk === "high" ? "#c0392b" : "#d68910"};
              border-radius: 8px; padding: 12px 14px; width: 300px;
              box-shadow: 0 6px 24px rgba(0,0,0,.18); }
      .risk { text-transform: uppercase; letter-spacing: .06em; font-size: 11px;
              font-weight: 700; color: ${risk === "high" ? "#c0392b" : "#b9770e"}; }
      .what { margin: 6px 0 2px; font-weight: 600; }
      .why  { margin: 0 0 10px; color: #555; }
      .row  { display: flex; gap: 8px; justify-content: flex-end; }
      button { font: inherit; padding: 5px 12px; border-radius: 6px; cursor: pointer;
               border: 1px solid #c4c4c4; background: #f5f5f5; }
      button.go { background: #1a5fb4; border-color: #1a5fb4; color: #fff; }
    </style>
    <div class="card" role="alertdialog" aria-label="PrivAgent action confirmation">
      <div class="risk">${risk} risk - confirmation required</div>
      <p class="what"></p>
      <p class="why"></p>
      <div class="row">
        <button class="no">Deny</button>
        <button class="go">Allow</button>
      </div>
    </div>`;

  // textContent, never innerHTML: the explanation is model output, not trusted markup.
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
