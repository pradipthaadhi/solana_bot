export function requestNotifyPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) {
    return Promise.resolve("denied");
  }
  return Notification.requestPermission();
}

export function notifyDesktop(title: string, body: string): void {
  if (!("Notification" in window) || Notification.permission !== "granted") {
    return;
  }
  try {
    new Notification(title, { body });
  } catch {
    // ignore
  }
}

export function appendToast(container: HTMLElement, title: string, message: string, ttlMs = 12_000): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<div class="t">${escapeHtml(title)}</div><div class="m">${escapeHtml(message)}</div>`;
  container.appendChild(el);
  window.setTimeout(() => el.remove(), ttlMs);
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
