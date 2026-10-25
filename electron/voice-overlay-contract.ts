export type VoiceOverlayPosition = "top-left" | "bottom-left" | "top-right" | "bottom-right";
export type VoiceOverlayAvatarSize = "small" | "large";
export type VoiceOverlayNameDisplay = "always" | "speaking" | "never";
export type VoiceOverlayNotificationCategory = "mention" | "reply" | "friend_request" | "dm_request" | "system";
export type VoiceOverlayNotificationStatus = "loading" | "ready" | "unavailable";
export type VoiceOverlayChatStatus = "ready" | "unavailable";

export type VoiceOverlayParticipant = {
  id: string;
  name: string;
  avatarUrl: string;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
};

export type VoiceOverlaySnapshot = {
  enabled: boolean;
  voiceOverlayMode?: "desktop" | "game";
  voiceOverlayPinned?: boolean;
  voiceOverlayQuickActions?: boolean;
  voiceOverlayClickableActions?: boolean;
  voiceOverlayActivity?: boolean;
  voiceOverlayWelcome?: boolean;
  voiceOverlayGoLive?: boolean;
  goLiveEligible?: boolean;
  goLiveSession?: string;
  overlayNotificationDurationMs?: number;
  activities?: Array<{ userId: string; label: string; gameName: string }>;
  voiceOverlayNotifications?: boolean;
  voiceOverlayNotificationActions?: boolean;
  notificationStatus?: VoiceOverlayNotificationStatus;
  notifications?: Array<{ id: string; category: VoiceOverlayNotificationCategory }>;
  voiceOverlayChat?: boolean;
  voiceOverlayChatActions?: boolean;
  voiceOverlayChatCompose?: boolean;
  chatStatus?: VoiceOverlayChatStatus;
  chatMessages?: Array<{ id: string; author: string; text: string }>;
  chatActionSession?: string;
  chatComposeSession?: string;
  chatComposeLabel?: string;
  voiceActionSession?: string;
  notificationActionSession?: string;
  notificationReplySession?: string;
  notificationReplyIds?: string[];
  selfMuted?: boolean;
  selfDeafened?: boolean;
  participants: VoiceOverlayParticipant[];
  speakingOpacity: number;
  idleOpacity: number;
  scale: number;
  position: VoiceOverlayPosition;
  speakingOnly: boolean;
  voiceOverlayAvatarSize: VoiceOverlayAvatarSize;
  voiceOverlayNameDisplay: VoiceOverlayNameDisplay;
  voiceOverlayMaxParticipants: number;
};

const MAX_PARTICIPANTS = 64;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 128;
const MAX_AVATAR_URL_LENGTH = 2048;
const MAX_OVERLAY_NOTIFICATIONS = 3;
const MAX_OVERLAY_CHAT_MESSAGES = 5;
const NOTIFICATION_CATEGORIES = new Set<VoiceOverlayNotificationCategory>(["mention", "reply", "friend_request", "dm_request", "system"]);
const NOTIFICATION_STATUSES = new Set<VoiceOverlayNotificationStatus>(["loading", "ready", "unavailable"]);
const CHAT_STATUSES = new Set<VoiceOverlayChatStatus>(["ready", "unavailable"]);
const POSITIONS = new Set<VoiceOverlayPosition>(["top-left", "bottom-left", "top-right", "bottom-right"]);
const AVATAR_SIZES = new Set<VoiceOverlayAvatarSize>(["small", "large"]);
const NAME_DISPLAY_MODES = new Set<VoiceOverlayNameDisplay>(["always", "speaking", "never"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedText(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maxLength &&
    (allowEmpty || value.trim().length > 0) && !CONTROL_CHARS.test(value);
}

function isAvatarUrl(value: unknown): value is string {
  if (!isBoundedText(value, MAX_AVATAR_URL_LENGTH, true)) return false;
  if (value === "") return true;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return true;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function isFiniteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Strictly project the renderer snapshot shape. New widget options are
 * optional only for legacy renderers: small avatar, always-visible names,
 * and 25 participants preserve the previous overlay behavior.
 */
export function parseVoiceOverlaySnapshot(raw: unknown): VoiceOverlaySnapshot | null {
  if (!isRecord(raw)) return null;
  if (raw.welcome !== undefined || raw.welcomeHeight !== undefined || raw.goLive !== undefined || raw.goLiveHeight !== undefined || raw.notificationReplyButtons !== undefined) return null;
  if (raw.overlayNotificationDurationMs !== undefined && (!Number.isInteger(raw.overlayNotificationDurationMs) || !isFiniteRange(raw.overlayNotificationDurationMs, 3000, 20000))) return null;
  if (typeof raw.enabled !== "boolean" || typeof raw.speakingOnly !== "boolean") return null;
  if (raw.voiceOverlayMode !== undefined && raw.voiceOverlayMode !== "desktop" && raw.voiceOverlayMode !== "game") return null;
  if (raw.voiceOverlayPinned !== undefined && typeof raw.voiceOverlayPinned !== "boolean") return null;
  for (const key of ["voiceOverlayQuickActions", "voiceOverlayClickableActions", "voiceOverlayActivity", "voiceOverlayWelcome", "voiceOverlayGoLive", "goLiveEligible", "voiceOverlayNotifications", "voiceOverlayNotificationActions", "voiceOverlayChat", "voiceOverlayChatActions", "voiceOverlayChatCompose", "selfMuted", "selfDeafened"]) if (raw[key] !== undefined && typeof raw[key] !== "boolean") return null;
  if (raw.goLiveSession !== undefined && !isBoundedText(raw.goLiveSession, 256)) return null;
  if (raw.goLiveEligible === true && (raw.voiceOverlayGoLive !== true || !isBoundedText(raw.goLiveSession, 256))) return null;
  if (raw.notificationStatus !== undefined && (typeof raw.notificationStatus !== "string" || !NOTIFICATION_STATUSES.has(raw.notificationStatus as VoiceOverlayNotificationStatus))) return null;
  if (raw.notifications !== undefined && (!Array.isArray(raw.notifications) || raw.notifications.length > MAX_OVERLAY_NOTIFICATIONS)) return null;
  if ((raw.notificationStatus !== undefined || raw.notifications !== undefined) && raw.voiceOverlayNotifications !== true) return null;
  const notifications: Array<{ id: string; category: VoiceOverlayNotificationCategory }> = [];
  const notificationIds = new Set<string>();
  for (const value of (raw.notifications ?? []) as unknown[]) {
    if (!isRecord(value) || !isBoundedText(value.id, MAX_ID_LENGTH) || typeof value.category !== "string" ||
      !NOTIFICATION_CATEGORIES.has(value.category as VoiceOverlayNotificationCategory) || notificationIds.has(value.id)) return null;
    notificationIds.add(value.id);
    notifications.push({ id: value.id, category: value.category as VoiceOverlayNotificationCategory });
  }
  if (notifications.length > 0 && raw.notificationStatus !== "ready") return null;
  const replyIds = raw.notificationReplyIds ?? [];
  if (!Array.isArray(replyIds) || replyIds.length > 3 || new Set(replyIds).size !== replyIds.length
    || replyIds.some(id => !isBoundedText(id, 128) || !notifications.some(n => n.id === id && (n.category === "mention" || n.category === "reply")))) return null;
  if (raw.notificationReplySession !== undefined && (!isBoundedText(raw.notificationReplySession, 256)
    || raw.voiceOverlayNotificationActions !== true || raw.voiceOverlayNotifications !== true || raw.notificationStatus !== "ready" || replyIds.length === 0)) return null;
  if (replyIds.length > 0 && !isBoundedText(raw.notificationReplySession, 256)) return null;
  if (raw.chatStatus !== undefined && (typeof raw.chatStatus !== "string" || !CHAT_STATUSES.has(raw.chatStatus as VoiceOverlayChatStatus))) return null;
  if (raw.chatMessages !== undefined && (!Array.isArray(raw.chatMessages) || raw.chatMessages.length > MAX_OVERLAY_CHAT_MESSAGES)) return null;
  if ((raw.chatStatus !== undefined || raw.chatMessages !== undefined) && raw.voiceOverlayChat !== true) return null;
  const chatMessages: Array<{ id: string; author: string; text: string }> = [];
  const chatIds = new Set<string>();
  for (const value of (raw.chatMessages ?? []) as unknown[]) {
    if (!isRecord(value) || Object.keys(value).length !== 3 || !["id", "author", "text"].every((key) => Object.prototype.hasOwnProperty.call(value, key)) ||
      !isBoundedText(value.id, 128) || !isBoundedText(value.author, 128)) return null;
    if (typeof value.text !== "string" || value.text.length > 500 || value.text.trim().length === 0) return null;
    const text = value.text.replace(/\r\n?/g, "\n");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || chatIds.has(value.id)) return null;
    chatIds.add(value.id);
    chatMessages.push({ id: value.id, author: value.author, text });
  }
  if (chatMessages.length > 0 && raw.chatStatus !== "ready") return null;
  if (raw.chatActionSession !== undefined && (!isBoundedText(raw.chatActionSession, 256) || raw.voiceOverlayChat !== true || raw.voiceOverlayChatActions !== true || raw.chatStatus !== "ready")) return null;
  if (raw.voiceOverlayChatCompose === true && (!isBoundedText(raw.chatComposeSession, 256) || raw.voiceOverlayChat !== true || raw.voiceOverlayChatActions !== true || raw.chatStatus !== "ready")) return null;
  if (raw.chatComposeSession !== undefined && (!isBoundedText(raw.chatComposeSession, 256) || raw.voiceOverlayChat !== true || raw.voiceOverlayChatActions !== true || raw.voiceOverlayChatCompose !== true || raw.chatStatus !== "ready")) return null;
  if (raw.chatComposeLabel !== undefined && (!isBoundedText(raw.chatComposeLabel, 128) || /[\u0080-\u009f]/.test(raw.chatComposeLabel as string) || raw.voiceOverlayChatCompose !== true || !raw.chatComposeSession)) return null;
  if (raw.activities !== undefined && (!Array.isArray(raw.activities) || raw.activities.length > 5)) return null;
  const activities: Array<{ userId: string; label: string; gameName: string }> = [];
  for (const value of (raw.activities ?? []) as unknown[]) {
    if (!isRecord(value) || !isBoundedText(value.userId, 128) || !isBoundedText(value.label, 128) || !isBoundedText(value.gameName, 128)
      || activities.some((row) => row.userId === value.userId)) return null;
    activities.push({ userId: value.userId, label: value.label, gameName: value.gameName });
  }
  if (raw.voiceActionSession !== undefined && !isBoundedText(raw.voiceActionSession, 256)) return null;
  if (raw.notificationActionSession !== undefined && !isBoundedText(raw.notificationActionSession, 256)) return null;
  if (raw.notificationActionSession !== undefined && (raw.voiceOverlayNotificationActions !== true || raw.voiceOverlayNotifications !== true || raw.notificationStatus !== "ready" || notifications.length === 0)) return null;
  if (!Array.isArray(raw.participants) || raw.participants.length > MAX_PARTICIPANTS) return null;
  if (!isFiniteRange(raw.speakingOpacity, 20, 100) || !isFiniteRange(raw.idleOpacity, 0, 100)) return null;
  if (!isFiniteRange(raw.scale, 75, 150) || typeof raw.position !== "string" || !POSITIONS.has(raw.position as VoiceOverlayPosition)) return null;
  const avatarSize = raw.voiceOverlayAvatarSize === undefined ? "small" : raw.voiceOverlayAvatarSize;
  const nameDisplay = raw.voiceOverlayNameDisplay === undefined ? "always" : raw.voiceOverlayNameDisplay;
  const maxParticipants = raw.voiceOverlayMaxParticipants === undefined ? 25 : raw.voiceOverlayMaxParticipants;
  if (typeof avatarSize !== "string" || !AVATAR_SIZES.has(avatarSize as VoiceOverlayAvatarSize) ||
    typeof nameDisplay !== "string" || !NAME_DISPLAY_MODES.has(nameDisplay as VoiceOverlayNameDisplay) ||
    !Number.isInteger(maxParticipants) || !isFiniteRange(maxParticipants, 0, 25)) return null;

  const participants: VoiceOverlayParticipant[] = [];
  const ids = new Set<string>();
  for (const candidate of raw.participants) {
    if (!isRecord(candidate) ||
      !isBoundedText(candidate.id, MAX_ID_LENGTH) ||
      !isBoundedText(candidate.name, MAX_NAME_LENGTH) ||
      !isAvatarUrl(candidate.avatarUrl) ||
      typeof candidate.speaking !== "boolean" ||
      typeof candidate.muted !== "boolean" ||
      typeof candidate.deafened !== "boolean" || ids.has(candidate.id)) {
      return null;
    }
    ids.add(candidate.id);
    participants.push({
      id: candidate.id,
      name: candidate.name,
      avatarUrl: candidate.avatarUrl,
      speaking: candidate.speaking,
      muted: candidate.muted,
      deafened: candidate.deafened,
    });
  }

  return {
    enabled: raw.enabled,
    ...(raw.voiceOverlayMode !== undefined ? { voiceOverlayMode: raw.voiceOverlayMode as "desktop" | "game" } : {}),
    ...(raw.voiceOverlayPinned !== undefined ? { voiceOverlayPinned: raw.voiceOverlayPinned as boolean } : {}),
    ...(raw.voiceOverlayQuickActions !== undefined ? { voiceOverlayQuickActions: raw.voiceOverlayQuickActions as boolean } : {}),
    ...(raw.voiceOverlayClickableActions !== undefined ? { voiceOverlayClickableActions: raw.voiceOverlayClickableActions as boolean } : {}),
    ...(raw.overlayNotificationDurationMs !== undefined ? { overlayNotificationDurationMs: raw.overlayNotificationDurationMs as number } : {}),
    ...(raw.voiceOverlayGoLive !== undefined ? { voiceOverlayGoLive: raw.voiceOverlayGoLive as boolean } : {}),
    ...(raw.goLiveSession !== undefined ? { goLiveSession: raw.goLiveSession as string } : {}),
    ...(raw.goLiveEligible !== undefined ? { goLiveEligible: raw.goLiveEligible as boolean } : {}),
    ...(raw.voiceOverlayWelcome !== undefined ? { voiceOverlayWelcome: raw.voiceOverlayWelcome as boolean } : {}),
    ...(raw.voiceOverlayActivity !== undefined ? { voiceOverlayActivity: raw.voiceOverlayActivity as boolean } : {}),
    ...(raw.activities !== undefined ? { activities } : {}),
    ...(raw.voiceOverlayNotifications !== undefined ? { voiceOverlayNotifications: raw.voiceOverlayNotifications as boolean } : {}),
    ...(raw.voiceOverlayNotificationActions !== undefined ? { voiceOverlayNotificationActions: raw.voiceOverlayNotificationActions as boolean } : {}),
    ...(raw.notificationStatus !== undefined ? { notificationStatus: raw.notificationStatus as VoiceOverlayNotificationStatus } : {}),
    ...(raw.notifications !== undefined ? { notifications } : {}),
    ...(raw.voiceOverlayChat !== undefined ? { voiceOverlayChat: raw.voiceOverlayChat as boolean } : {}),
    ...(raw.voiceOverlayChatActions !== undefined ? { voiceOverlayChatActions: raw.voiceOverlayChatActions as boolean } : {}),
    ...(raw.voiceOverlayChatCompose !== undefined ? { voiceOverlayChatCompose: raw.voiceOverlayChatCompose as boolean } : {}),
    ...(raw.chatStatus !== undefined ? { chatStatus: raw.chatStatus as VoiceOverlayChatStatus } : {}),
    ...(raw.chatMessages !== undefined ? { chatMessages } : {}),
    ...(raw.chatActionSession !== undefined ? { chatActionSession: raw.chatActionSession as string } : {}),
    ...(raw.chatComposeSession !== undefined ? { chatComposeSession: raw.chatComposeSession as string } : {}),
    ...(raw.chatComposeLabel !== undefined ? { chatComposeLabel: raw.chatComposeLabel as string } : {}),
    ...(raw.voiceActionSession !== undefined ? { voiceActionSession: raw.voiceActionSession as string } : {}),
    ...(raw.notificationReplySession !== undefined ? { notificationReplySession: raw.notificationReplySession as string } : {}),
    ...(raw.notificationReplyIds !== undefined ? { notificationReplyIds: replyIds as string[] } : {}),
    ...(raw.notificationActionSession !== undefined ? { notificationActionSession: raw.notificationActionSession as string } : {}),
    ...(raw.selfMuted !== undefined ? { selfMuted: raw.selfMuted as boolean } : {}),
    ...(raw.selfDeafened !== undefined ? { selfDeafened: raw.selfDeafened as boolean } : {}),
    participants,
    speakingOpacity: raw.speakingOpacity,
    idleOpacity: raw.idleOpacity,
    scale: raw.scale,
    position: raw.position as VoiceOverlayPosition,
    speakingOnly: raw.speakingOnly,
    voiceOverlayAvatarSize: avatarSize as VoiceOverlayAvatarSize,
    voiceOverlayNameDisplay: nameDisplay as VoiceOverlayNameDisplay,
    voiceOverlayMaxParticipants: maxParticipants,
  };
}

export interface VoiceOverlayLifecycleTarget {
  identity?: object;
  isDestroyed(): boolean;
  isLoading(): boolean;
  onDidFinishLoad(callback: () => void): void;
  hide(): void;
  deliver(snapshot: VoiceOverlaySnapshot): void;
}

export interface VoiceOverlayIpcSender {
  sender: unknown;
  senderFrame: unknown;
}

export interface VoiceOverlayMainWindow {
  isDestroyed(): boolean;
  webContents: { mainFrame: unknown };
}

export function isTrustedVoiceOverlaySender(
  event: VoiceOverlayIpcSender,
  mainWindow: VoiceOverlayMainWindow | null,
): boolean {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents &&
    event.senderFrame !== null && event.senderFrame !== undefined && event.senderFrame === mainWindow.webContents.mainFrame;
}

export function hasVoiceOverlayContent(snapshot: VoiceOverlaySnapshot): boolean {
  return snapshot.enabled && ((snapshot.voiceOverlayMaxParticipants > 0 && snapshot.participants.length > 0)
    || (snapshot.voiceOverlayQuickActions === true && !!snapshot.voiceActionSession)
    || snapshot.voiceOverlayActivity === true
    || snapshot.voiceOverlayNotifications === true
    || snapshot.voiceOverlayChat === true);
}

/** Fences deferred renderer delivery so stale loads cannot resurrect an overlay. */
export class VoiceOverlayLifecycle {
  private latest: VoiceOverlaySnapshot | null = null;
  private pending: { key: object; target: VoiceOverlayLifecycleTarget } | null = null;

  update(snapshot: VoiceOverlaySnapshot, target: VoiceOverlayLifecycleTarget): void {
    this.latest = snapshot;
    if (!hasVoiceOverlayContent(snapshot)) {
      target.hide();
      return;
    }

    const key = target.identity ?? target;
    if (target.isLoading()) {
      if (this.pending?.key !== key) {
        const pending = { key, target };
        this.pending = pending;
        target.onDidFinishLoad(() => {
          if (this.pending !== pending) return;
          this.pending = null;
          this.deliverLatest(target);
        });
      }
      return;
    }
    this.pending = null;
    this.deliverLatest(target);
  }

  close(): void {
    this.pending = null;
    this.latest = null;
  }

  private deliverLatest(target: VoiceOverlayLifecycleTarget): void {
    const snapshot = this.latest;
    if (!snapshot || !hasVoiceOverlayContent(snapshot) || target.isDestroyed()) return;
    target.deliver(snapshot);
  }
}
