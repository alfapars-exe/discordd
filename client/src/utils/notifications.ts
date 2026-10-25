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

import { getNotificationPreferences } from "./notificationPreferences";
import { getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { isCapacitor } from "./constants";

let permissionAsked = false;
type PendingNotification = {
  timer: ReturnType<typeof setTimeout>;
  tag?: string;
  userId: string;
  accountId: string;
  authGeneration: number;
  opts: ShowOptions;
};
const pendingByKey = new Map<string, PendingNotification>();
let pendingSequence = 0;
let pendingSubscriptions: Array<() => void> = [];
const MAX_PENDING_NOTIFICATIONS = 200;

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
  /** Rechecked at delivery for events whose source may become stale while queued. */
  isStillEligible?: () => boolean;
};

function cancelPendingNotifications(): void {
  for (const pending of pendingByKey.values()) clearTimeout(pending.timer);
  pendingByKey.clear();
  for (const unsubscribe of pendingSubscriptions) unsubscribe();
  pendingSubscriptions = [];
}

function observePendingNotifications(): void {
  if (pendingSubscriptions.length > 0) return;
  pendingSubscriptions.push(useAuthStore.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id || state.manualStatus === "dnd" || state.manualStatus === "offline"
      || [...pendingByKey.values()].some((pending) => pending.authGeneration !== getAuthGeneration())) {
      cancelPendingNotifications();
    }
  }));
  pendingSubscriptions.push(usePreferencesStore.subscribe((state, previous) => {
    const before = previous.data.notifications as Record<string, unknown> | undefined;
    const after = state.data.notifications as Record<string, unknown> | undefined;
    if (after?.desktopEnabled === false || state.accountId !== previous.accountId || before?.desktopDelaySeconds !== after?.desktopDelaySeconds) {
      cancelPendingNotifications();
    }
  }));
}

function canDeliver(pending: PendingNotification): boolean {
  const auth = useAuthStore.getState();
  const preferences = usePreferencesStore.getState();
  const prefs = getNotificationPreferences();
  if (!auth.user?.id || auth.user.id !== pending.userId || preferences.accountId !== pending.accountId) return false;
  if (getAuthGeneration() !== pending.authGeneration || !prefs.desktopEnabled || !notificationsEnabled()) return false;
  if (auth.manualStatus === "dnd" || auth.manualStatus === "offline") return false;
  if (!prefs.notifyWhenFocused && typeof document !== "undefined" && !document.hidden && document.hasFocus()) return false;
  try { return pending.opts.isStillEligible?.() !== false; } catch { return false; }
}

function deliver(pending: PendingNotification): void {
  if (!canDeliver(pending)) return;
  try {
    const n = new Notification(pending.opts.title, {
      body: pending.opts.body,
      icon: pending.opts.icon ?? undefined,
      tag: pending.opts.tag,
      silent: true,
    });
    if (pending.opts.onClick) {
      n.onclick = () => {
        try {
          window.focus();
          pending.opts.onClick?.();
        } finally { n.close(); }
      };
    }
  } catch (err) {
    console.warn("[notifications] failed to show:", err);
  }
}

/**
 * Fire an OS toast. Drops silently if:
 *  • Permission isn't granted (no prompt, no error)
 *  • The tab is currently visible AND focused (would duplicate in-app cue)
 *
 * Callers decide whether the source event is eligible. Delayed deliveries
 * recheck that source, account/session, permission, DND, and foreground policy.
 */
export function showNotification(opts: ShowOptions): void {
  const prefs = getNotificationPreferences();
  if (!prefs.desktopEnabled) return;
  if (!notificationsEnabled()) return;
  // Foreground gate — let the in-app cue handle visible+focused tabs.
  if (!prefs.notifyWhenFocused && typeof document !== "undefined" && !document.hidden && document.hasFocus()) {
    return;
  }
  const auth = useAuthStore.getState();
  const preferences = usePreferencesStore.getState();
  if (!auth.user?.id || !preferences.accountId || preferences.accountId !== auth.user.id) return;
  const pending: PendingNotification = {
    timer: 0 as unknown as ReturnType<typeof setTimeout>,
    tag: opts.tag,
    userId: auth.user.id,
    accountId: preferences.accountId,
    authGeneration: getAuthGeneration(),
    opts,
  };
  // The preference is explicitly desktop-only; Capacitor keeps native timing.
  const delayMs = (isCapacitor() ? 0 : prefs.desktopDelaySeconds) * 1000;
  if (!delayMs) {
    deliver(pending);
    return;
  }
  observePendingNotifications();
  const key = opts.tag ? `tag:${opts.tag}` : `untagged:${++pendingSequence}`;
  const old = pendingByKey.get(key);
  if (old) clearTimeout(old.timer);
  else if (pendingByKey.size >= MAX_PENDING_NOTIFICATIONS) return;
  pending.timer = setTimeout(() => {
    if (pendingByKey.get(key) !== pending) return;
    pendingByKey.delete(key);
    deliver(pending);
    if (pendingByKey.size === 0) {
      for (const unsubscribe of pendingSubscriptions) unsubscribe();
      pendingSubscriptions = [];
    }
  }, delayMs);
  pendingByKey.set(key, pending);
}

/** Explicit cancellation is useful on lifecycle transitions and deterministic tests. */
export function cancelPendingDesktopNotifications(): void { cancelPendingNotifications(); }
