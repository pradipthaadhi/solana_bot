import { parseSecretKeyInput } from "./secretKeyParse.js";
import { getSessionTradingKeypair, setSessionTradingKeypair } from "./sessionTradingKey.js";

/**
 * Blocks the desk until the user submits a valid Solana private key (session memory only — not persisted).
 */
export function requireTradingSessionKey(): Promise<void> {
  if (getSessionTradingKeypair() !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "key-gate-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "key-gate-title");

    const card = document.createElement("div");
    card.className = "key-gate-card glass-deck";

    const title = document.createElement("h2");
    title.id = "key-gate-title";
    title.className = "key-gate-title";
    title.textContent = "Trading session key";

    const p = document.createElement("p");
    p.className = "key-gate-copy";
    p.textContent =
      "Enter the wallet private key used for automated swaps when BUY/SELL signals fire. The key stays in this tab’s memory only (not localStorage). Use a dedicated hot wallet and never share this screen.";

    const label = document.createElement("label");
    label.className = "key-gate-label";
    label.htmlFor = "key-gate-input";
    label.textContent = "Private key (base58 or JSON byte array)";

    const input = document.createElement("textarea");
    input.id = "key-gate-input";
    input.className = "key-gate-input";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.rows = 3;
    input.placeholder = "Paste secret key…";

    const err = document.createElement("p");
    err.className = "key-gate-err";
    err.hidden = true;

    const row = document.createElement("div");
    row.className = "key-gate-actions";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "primary btn-pill-glow";
    btn.textContent = "Unlock desk";

    const finish = (): void => {
      backdrop.remove();
      resolve();
    };

    const submit = (): void => {
      const parsed = parseSecretKeyInput(input.value);
      if (!parsed.ok) {
        err.textContent = parsed.error;
        err.hidden = false;
        return;
      }
      err.hidden = true;
      setSessionTradingKeypair(parsed.keypair);
      finish();
    };

    btn.addEventListener("click", () => submit());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        submit();
      }
    });

    row.appendChild(btn);
    card.append(title, p, label, input, err, row);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    queueMicrotask(() => input.focus());
  });
}
