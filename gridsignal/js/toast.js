/**
 * Toast-Notification System
 * Zeigt Benachrichtigungen oben rechts (auto-dismiss nach 4 s).
 */

const ICONS = {
  success: `<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  error:   `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  warning: `<svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info:    `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
};

function getContainer() {
  let el = document.getElementById("toast-container");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-container";
    el.className = "toast-container";
    document.body.appendChild(el);
  }
  return el;
}

/**
 * @param {"success"|"error"|"warning"|"info"} type
 * @param {string} title
 * @param {string} [message]
 * @param {number} [duration] - ms, 0 = kein auto-dismiss
 */
export function showToast(type = "info", title = "", message = "", duration = 4000) {
  const container = getContainer();
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  toast.innerHTML = `
    <div class="toast-icon">${ICONS[type] || ICONS.info}</div>
    <div class="toast-body">
      <div class="toast-title">${escHtml(title)}</div>
      ${message ? `<div class="toast-message">${escHtml(message)}</div>` : ""}
    </div>
    <button class="toast-close" aria-label="Schließen">
      <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;

  container.appendChild(toast);

  const dismiss = () => {
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 200);
  };

  toast.querySelector(".toast-close")?.addEventListener("click", dismiss);

  if (duration > 0) setTimeout(dismiss, duration);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
