import { parseSecretKeyInput } from "./secretKeyParse.js";
import { getSessionTradingKeypair, setSessionTradingKeypair } from "./sessionTradingKey.js";

/**
 * Blocks the desk on first paint until a valid private key is stored in this tab’s memory
 * (`setSessionTradingKeypair`). Not persisted to localStorage. Required so automated BUY/SELL
 * signal execution can sign Jupiter swaps.
 */
export function requireDeskTradingKey(): Promise<void> {
  if (getSessionTradingKeypair() !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "key-gate-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "key-gate-desk-title");

    const card = document.createElement("div");
    card.className = "key-gate-card glass-deck";

    const title = document.createElement("h2");
    title.id = "key-gate-desk-title";
    title.className = "key-gate-title";
    title.textContent = "Trading session key";

    const p = document.createElement("p");
    p.className = "key-gate-copy";
    p.textContent =
      "Required for automatic BUY/SELL when strategy signals fire. The key is kept in this tab’s memory only (not localStorage or disk). Use a dedicated hot wallet.";

    const wrap = document.createElement("div");
    wrap.className = "wallet-field wallet-field--secret key-gate-key-wrap";

    const label = document.createElement("label");
    label.className = "wallet-field-label";
    label.htmlFor = "key-gate-desk-inp";
    label.textContent = "Private key (base58 or JSON byte array)";

    const tooltip = document.createElement("div");
    tooltip.id = "key-gate-desk-tooltip";
    tooltip.className = "wallet-secret-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.setAttribute("aria-live", "polite");
    tooltip.hidden = true;
    tooltip.textContent = "Enter your private key to enable auto-execution. It is never written to storage.";

    const input = document.createElement("textarea");
    input.id = "key-gate-desk-inp";
    input.className = "wallet-secret-input key-gate-textarea";
    input.rows = 3;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.placeholder = "Paste secret key…";

    const errP = document.createElement("p");
    errP.className = "key-gate-err";
    errP.hidden = true;

    const row = document.createElement("div");
    row.className = "key-gate-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "primary btn-pill-glow";
    btn.textContent = "Unlock desk";

    const clearFieldError = (): void => {
      wrap.classList.remove("wallet-field--secret-error");
      input.classList.remove("wallet-secret-input--error");
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
      tooltip.hidden = true;
    };

    const showEmptyError = (): void => {
      wrap.classList.add("wallet-field--secret-error");
      input.classList.add("wallet-secret-input--error");
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", tooltip.id);
      tooltip.hidden = false;
    };

    const finish = (): void => {
      backdrop.remove();
      resolve();
    };

    const submit = (): void => {
      errP.hidden = true;
      const raw = input.value;
      if (raw.trim().length === 0) {
        errP.textContent = "";
        showEmptyError();
        void input.focus();
        return;
      }
      const parsed = parseSecretKeyInput(raw);
      if (!parsed.ok) {
        clearFieldError();
        wrap.classList.add("wallet-field--secret-error");
        input.classList.add("wallet-secret-input--error");
        input.setAttribute("aria-invalid", "true");
        errP.textContent = parsed.error;
        errP.hidden = false;
        return;
      }
      clearFieldError();
      setSessionTradingKeypair(parsed.keypair);
      input.value = "";
      finish();
    };

    input.addEventListener("input", () => {
      errP.textContent = "";
      errP.hidden = true;
      if (input.value.trim().length > 0) {
        clearFieldError();
      }
    });

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        submit();
      }
    });

    btn.addEventListener("click", () => submit());

    wrap.append(label, tooltip, input);
    row.appendChild(btn);
    card.append(title, p, wrap, errP, row);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    queueMicrotask(() => {
      void input.focus();
    });
  });
}
