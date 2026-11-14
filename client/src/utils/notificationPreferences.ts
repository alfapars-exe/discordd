import { usePreferencesStore } from "../stores/preferencesStore";

import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from "./notificationPreferenceDefaults";
export { DEFAULT_NOTIFICATION_PREFERENCES } from "./notificationPreferenceDefaults";
export type { NotificationPreferences } from "./notificationPreferenceDefaults";

export function getNotificationPreferences(): NotificationPreferences {
  const raw = usePreferencesStore.getState().data.notifications;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_NOTIFICATION_PREFERENCES;
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...raw } as NotificationPreferences;
}

export function shouldFlashTaskbar(): boolean {
  return getNotificationPreferences().taskbarFlash;
}

