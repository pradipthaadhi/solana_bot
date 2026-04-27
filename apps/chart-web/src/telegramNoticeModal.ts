/**
 * Notification modal on every full page load / reload. No persistence: OK only closes
 * for the current view; the next navigation or reload shows the modal again.
 * Only the OK button closes the dialog (Escape is blocked via `cancel`).
 */

function removeDialog(el: HTMLDialogElement): void {
  if (el.open) {
    el.close();
  }
  el.remove();
}

/**
 * If `showModal` fails, open as a non-modal dialog and draw a full-screen dim layer
 * (no ::backdrop, but still visible and blocking-looking).
 */
function openDialogWithFallback(el: HTMLDialogElement): void {
  if (typeof el.showModal === "function") {
    try {
      el.showModal();
      return;
    } catch {
      /* continue to fallback */
    }
  }
  el.setAttribute("open", "");
  el.classList.add("telegram-notice-dialog--open-fallback");
}

function scheduleShowDialog(dialog: HTMLDialogElement): void {
  const run = (): void => {
    openDialogWithFallback(dialog);
    (dialog.querySelector(".telegram-notice-dialog__ok") as HTMLButtonElement | null)?.focus();
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      run();
    });
  } else {
    setTimeout(run, 0);
  }
}

/** Shows the Telegram notice dialog after chart shell mount — runs on every load (including refresh). */
export function showTelegramNoticeModalIfFirstVisit(): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }

  const dialog = document.createElement("dialog");
  dialog.className = "telegram-notice-dialog";
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "telegram-notice-title");

  dialog.innerHTML = `
    <div class="telegram-notice-dialog__backdrop" aria-hidden="true"></div>
    <div class="telegram-notice-dialog__glow" aria-hidden="true"></div>
    <div class="telegram-notice-dialog__inner">
      <div class="telegram-notice-dialog__head">
        <h2 class="telegram-notice-dialog__title" id="telegram-notice-title">Notification</h2>
      </div>
      <div class="telegram-notice-dialog__body">
        <p class="telegram-notice-dialog__text">
          Please check your telegram channel. Let's chat with telegram channel. Yulius
        </p>
      </div>
      <div class="telegram-notice-dialog__footer">
        <button type="button" class="telegram-notice-dialog__ok" data-telegram-notice-ok>OK</button>
      </div>
    </div>
  `;

  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
  });

  dialog.querySelector("[data-telegram-notice-ok]")?.addEventListener("click", () => {
    removeDialog(dialog);
  });

  document.body.appendChild(dialog);
  scheduleShowDialog(dialog);
}
