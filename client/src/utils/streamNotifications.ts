import type { AppNotification } from "../types";
import type { NotificationPreferences } from "./notificationPreferences";

export function shouldCueStream(n: AppNotification, prefs: NotificationPreferences, userId: string | undefined, status: string | undefined, focused: boolean): boolean {
  return n.kind === "system" && n.payload.action === "stream_start" && n.user_id === userId
    && !!n.actor_id && n.actor_id !== userId && n.read_at === null && prefs.streamNotifications
    && status !== "dnd" && status !== "offline" && (!focused || prefs.notifyWhenFocused);
}
