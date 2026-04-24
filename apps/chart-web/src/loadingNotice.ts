const ID = "loading-notice";
let didDismiss = false;

function dismiss(): void {
  if (didDismiss || typeof document === "undefined") {
    return;
  }
  const root = document.getElementById(ID);
  if (!root) {
    return;
  }
  didDismiss = true;
  root.classList.add("loading-notice--dismissed");
  root.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    root.remove();
  }, 400);
}

/** Wires the close control; the notice is removed only when the user clicks that button. */
export function bindLoadingNotice(): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.getElementById(ID);
  if (!root) {
    return;
  }
  document.getElementById("loading-notice-dismiss")?.addEventListener("click", () => dismiss(), { once: true });
}
