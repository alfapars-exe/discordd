/**
 * notifications — OS-level system notification helper.
 *
 * Until now the app only showed in-app cues for new messages: red
 * unread dot in the sidebar, taskbar badge, favicon overlay, ping
 * sound, and (in Electron) a window flash. None of those reach the
 * user when the app is minimized to the system tray or behind another
 * window — they only catch their attention if they look at HiChat
 * already. This module adds the missing piece: a real OS toast
 * (Windows Action Center, macOS Notification Center, browser native).
 *
 * The Web Notification API works the same way in a browser tab and
 * inside Electron's renderer, so one code path covers both. Electron
 * additionally maps the toast onto the Windows AppUserModelID we set
 * in main.ts, so the OS groups our notifications under "HiChat!"
 * rather than under a generic Electron host.
 *
 * Design notes (intentional, don't strip on a future refactor):
 *
 *   • One-shot permission request. We ask exactly once per session.
 *     If the user denied earlier we don't nag them with another
 *     prompt — caller code just gets no-op showNotification() calls.
 *
 *   • Caller decides whether to fire. This util has NO opinion on
 *     muting / focus / mention vs. background message — every gating
 *     decision (channel muted, kullanıcı sayfayı görüntülüyor, vs.)
 *     lives in the callsite. Keeps the gating logic next to the
 *     other in-app cues (sound, flash, unread bump) instead of
 *     scattered.
 *
 *   • document.hidden gate. We only fire a toast if the tab is in
 *     the background or the OS window doesn't have focus. Foreground
 *     toasts duplicate the in-app cue and feel noisy. Electron's
 *     document.hidden returns true when the window is minimized;
 *     for hidden-but-unfocused (clicked away from), document.hasFocus()
 *     covers the gap.
 */

let permissionAsked = false;

/**
 * Returns true if the browser/Electron supports notifications AND
 * the user has granted permission. Safe to call any time — it just
 * reads `Notification.permission` synchronously.
 */
export function notificationsEnabled(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    Notification.permission === "granted"
  );
}

/**
 * Ask the OS for notification permission once per session. Called
 * from AppLayout after login; calling again is a no-op. Returns the
 * resolved permission state so the caller can react (e.g. log it).
 */
export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "denied";
  }
  if (Notification.permission !== "default") {
    // Already granted or denied — don't re-prompt.
    return Notification.permission;
  }
  if (permissionAsked) {
    return Notification.permission;
  }
  permissionAsked = true;
  try {
    return await Notification.requestPermission();
  } catch {
    // Some embedded WebViews throw — treat as denied silently.
    return "denied";
  }
}

type ShowOptions = {
  title: string;
  body?: string;
  /** Direct URL (avatar) — accepts data: URIs and https. */
  icon?: string | null;
  /**
   * Tag groups successive toasts so the OS replaces an older one
   * from the same channel/DM instead of stacking dozens. Pass the
   * channel/DM id so multiple new messages in the same room
   * collapse into a single toast.
   */
  tag?: string;
  /** Click handler — usually "focus the window + jump to channel". */
  onClick?: () => void;
};

/**
 * Fire an OS toast. Drops silently if:
 *  • Permission isn't granted (no prompt, no error)
 *  • The tab is currently visible AND focused (would duplicate in-app cue)
 *
 * Caller is responsible for higher-level gating: muted channels,
 * mentions-only mode, do-not-disturb, etc.
 */
export function showNotification(opts: ShowOptions): void {
  if (!notificationsEnabled()) return;
  // Foreground gate — let the in-app cue handle visible+focused tabs.
  if (typeof document !== "undefined" && !document.hidden && document.hasFocus()) {
    return;
  }
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      icon: opts.icon ?? undefined,
      tag: opts.tag,
      // silent:false lets the OS pick its own toast sound — we already
      // play playNotificationSound() inside the app, so leaving this
      // silent avoids a double-beep.
      silent: true,
    });
    if (opts.onClick) {
      n.onclick = () => {
        try {
          window.focus();
          opts.onClick?.();
        } finally {
          n.close();
        }
      };
    }
  } catch (err) {
    // Some Linux desktops + niche WebViews throw on construct — non-fatal.
    console.warn("[notifications] failed to show:", err);
  }
}
