import type { VoiceOverlaySnapshot, OverlayGameActivityNotice } from "./voice-overlay-contract";
import type { VoiceOverlayWindowGeometry } from "./voice-overlay-geometry";
import type { OverlayWelcomeNotice } from "./overlay-welcome";

type HUDState = {
  gameActivityNotices: OverlayGameActivityNotice[];
  goLive: OverlayWelcomeNotice | null;
  welcome: OverlayWelcomeNotice | null;
  notificationActionsUnavailable: boolean;
  unlocked: boolean;
  layoutSaveFailed: boolean;
  quickActionsUnavailable: boolean;
};

/** Project bounded HUD rows; timers, lifecycle and platform ownership stay in the caller. */
export function overlayHUDPayload(snapshot: VoiceOverlaySnapshot, geometry: VoiceOverlayWindowGeometry | null, state: HUDState) {
  return { ...snapshot, mediaHeight: geometry?.mediaHeight ?? 0, goLiveHeight: geometry?.goLiveHeight ?? 0,
    gameActivityNotices: state.gameActivityNotices.slice(0, geometry?.gameActivityNoticeRows ?? 0),
    gameActivityNoticeHeight: geometry?.gameActivityNoticeHeight ?? 0,
    goLive: state.goLive,
    welcomeHeight: geometry?.welcomeHeight ?? 0,
    welcome: state.welcome,
    voiceOverlayMaxParticipants: geometry?.effectiveMaxParticipants ?? 0,
    voiceOverlayActivity: geometry?.activityVisible ?? false,
    activities: geometry?.activityVisible ? (snapshot.activities ?? []).slice(0, geometry.activityRows) : [],
    voiceOverlayNotifications: geometry?.notificationsVisible ?? false,
    notifications: geometry?.notificationsVisible ? (snapshot.notifications ?? []).slice(0, geometry.notificationRows) : [],
    voiceOverlayChat: geometry?.chatVisible ?? false,
    chatStatus: geometry?.chatVisible ? snapshot.chatStatus : undefined,
    chatMessages: geometry?.chatVisible ? (snapshot.chatMessages ?? []).slice(-geometry.chatRows) : undefined,
    notificationActionsUnavailable: snapshot.voiceOverlayNotificationActions === true && state.notificationActionsUnavailable,
    unlocked: state.unlocked, layoutSaveFailed: state.layoutSaveFailed, quickActionsUnavailable: state.quickActionsUnavailable };
}
