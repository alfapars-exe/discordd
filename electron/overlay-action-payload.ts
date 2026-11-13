import type { VoiceOverlaySnapshot } from "./voice-overlay-contract";

/** Project action-only data after the owner has revalidated availability and session. */
export function chatActionPayload(snapshot: VoiceOverlaySnapshot, expanded: boolean) {
  return {
      enabled: true, voiceOverlayChat: true, voiceOverlayChatActions: true,
      chatStatus: "ready", chatMessages: [], chatActionSession: snapshot.chatActionSession,
      voiceOverlayChatCompose: expanded, chatComposeSession: expanded ? snapshot.chatComposeSession : undefined,
      participants: [], voiceOverlayNotifications: false, notifications: [], notificationStatus: undefined,
      notificationActionSession: undefined,
    };
}

export function notificationActionPayload(snapshot: VoiceOverlaySnapshot, replyButtons: Array<{ id: string; row: number }>) {
  return {
      enabled: true, voiceOverlayNotifications: true, voiceOverlayNotificationActions: true,
      notificationActionSession: snapshot.notificationActionSession, participants: [],
      notificationReplySession: snapshot.notificationReplySession, notificationReplyButtons: replyButtons,
      voiceOverlayChat: false, voiceOverlayChatActions: false, voiceOverlayChatCompose: false, chatStatus: undefined, chatMessages: undefined, chatActionSession: undefined, chatComposeSession: undefined, chatComposeLabel: undefined,
    };
}

export function voiceActionPayload(snapshot: VoiceOverlaySnapshot, unlocked: boolean) {
  return { ...snapshot, participants: [], activities: [], voiceOverlayActivity: false, voiceOverlayNotifications: false, voiceOverlayNotificationActions: false, notificationActionSession: undefined, notifications: [], notificationStatus: undefined, voiceOverlayChat: false, voiceOverlayChatActions: false, voiceOverlayChatCompose: false, chatStatus: undefined, chatMessages: undefined, chatActionSession: undefined, chatComposeSession: undefined, chatComposeLabel: undefined, unlocked };
}
