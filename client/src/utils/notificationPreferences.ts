import { usePreferencesStore } from "../stores/preferencesStore";

export type NotificationPreferences = {
  desktopEnabled: boolean;
  taskbarFlash: boolean;
  unreadBadge: boolean;
  reactionMode: "all" | "direct" | "none";
  soundPack: "classic" | "soft" | "minimal";
  messageSound: boolean;
  currentChannelSound: boolean;
  incomingCallSound: boolean;
  muteAllSounds: boolean;
  voiceStreamStartSound: boolean;
  voiceStreamStopSound: boolean;
  voiceJoinSound: boolean;
  voiceLeaveSound: boolean;
  voiceWatchStartSound: boolean;
  voiceWatchStopSound: boolean;
  voiceMuteSound: boolean;
  voiceUnmuteSound: boolean;
  voiceDeafenSound: boolean;
  voiceUndeafenSound: boolean;

  notifyWhenFocused: boolean;
  /** Delay/coalesce OS desktop toasts; 0 delivers immediately. */
  desktopDelaySeconds: 0 | 3 | 5 | 10;
  streamNotifications: boolean;
  onlineFriendNotifications: boolean;
  friendAnniversaryNotifications: boolean;
  profileUpdateNotifications: boolean;
  upcomingEventNotifications: boolean;
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  desktopEnabled: true,
  taskbarFlash: true,
  unreadBadge: true,
  reactionMode: "direct",
  soundPack: "classic",
  messageSound: true,
  currentChannelSound: false,
  incomingCallSound: true,
  muteAllSounds: false,
  voiceStreamStartSound: true,
  voiceStreamStopSound: true,
  voiceJoinSound: true,
  voiceLeaveSound: true,
  voiceWatchStartSound: true,
  voiceWatchStopSound: true,
  voiceMuteSound: true,
  voiceUnmuteSound: true,
  voiceDeafenSound: true,
  voiceUndeafenSound: true,

  notifyWhenFocused: false,
  desktopDelaySeconds: 0,
  streamNotifications: true,
  onlineFriendNotifications: false,
  friendAnniversaryNotifications: true,
  profileUpdateNotifications: true,
  upcomingEventNotifications: true,
};

export function getNotificationPreferences(): NotificationPreferences {
  const raw = usePreferencesStore.getState().data.notifications;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_NOTIFICATION_PREFERENCES;
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...raw } as NotificationPreferences;
}

export function shouldFlashTaskbar(): boolean {
  return getNotificationPreferences().taskbarFlash;
}

