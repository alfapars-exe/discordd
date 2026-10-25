import type { AppNotification } from "../types";
import type { NotificationPreferences } from "./notificationPreferences";

export function anniversaryYears(n: AppNotification): number | null {
  const years = n.payload.years;
  return n.kind === "system" && n.payload.action === "friend_anniversary"
    && typeof years === "number" && Number.isSafeInteger(years) && years > 0 ? years : null;
}

export function shouldCueAnniversary(n: AppNotification, prefs: NotificationPreferences, userId: string | undefined, status: string | undefined, focused: boolean): boolean {
  return anniversaryYears(n) !== null && n.user_id === userId && !!n.actor_id && n.actor_id !== userId
    && n.read_at === null && prefs.friendAnniversaryNotifications && status !== "dnd" && status !== "offline"
    && (!focused || prefs.notifyWhenFocused);
}
