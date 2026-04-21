/** One-time gentle CTA emphasis for new visitors; clears on interaction or timeout. */
const STORAGE_KEY = "sol_bot_chart_intro_v1";

export function runFirstVisitIntro(): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return;
  }
  try {
    if (new URLSearchParams(window.location.search).get("replayIntro") === "1") {
      localStorage.removeItem(STORAGE_KEY);
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    if (localStorage.getItem(STORAGE_KEY) === "1") {
      return;
    }
  } catch {
    return;
  }

  document.documentElement.classList.add("first-visit-intro");

  const finish = (): void => {
    document.documentElement.classList.remove("first-visit-intro");
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* private mode */
    }
  };

  const t = window.setTimeout(finish, 9000);

  const early = (): void => {
    window.clearTimeout(t);
    finish();
  };

  document.getElementById("pool")?.addEventListener("focus", early, { once: true });
  document.getElementById("btn-load")?.addEventListener("click", early, { once: true });
  document.querySelector(".btn-connect-phantom")?.addEventListener("click", early, { once: true });
}
