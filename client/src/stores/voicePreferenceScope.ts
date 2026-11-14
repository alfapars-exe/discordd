/** Device-specific voice/overlay choices never enter account preference sync. */
export const DEVICE_LOCAL_VOICE_SETTING_KEYS = [
  "inputDevice", "outputDevice", "cameraDevice", "muteHotkeyGlobal",
  "voiceOverlayEnabled", "voiceOverlayMode", "voiceOverlaySpeakingOpacity", "voiceOverlayIdleOpacity",
  "voiceOverlayScale", "voiceOverlayPosition", "voiceOverlaySpeakingOnly",
  "voiceOverlayPinned",
  "voiceOverlayQuickActions", "voiceOverlayClickableActions",
  "voiceOverlayCompatibility",
  "voiceOverlayActivity", "voiceOverlayVideo", "voiceOverlayStreams", "voiceOverlayWelcome", "voiceOverlayGoLive",
  "voiceOverlayGameActivityNotifications", "voiceOverlayNowPlayingNotifications",
  "voiceOverlayNotifications",
  "voiceOverlayNotificationActions",
  "voiceOverlayChat",
  "voiceOverlayChatActions",
  "voiceOverlayChatCompose",
  "voiceOverlayAvatarSize", "voiceOverlayNameDisplay", "voiceOverlayMaxParticipants",
] as const;
