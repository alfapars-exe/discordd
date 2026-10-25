import type { VoiceOverlaySnapshot } from "./voice-overlay-contract";

export interface VoiceOverlayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VoiceOverlayWindowGeometry extends VoiceOverlayWorkArea {
  shouldShow: boolean;
  visibleParticipants: number;
  effectiveMaxParticipants: number;
  activityVisible: boolean;
  activityRows: number;
  chatVisible: boolean;
  chatRows: number;
  chatHeight: number;
  notificationsVisible: boolean;
  notificationRows: number;
  actionsHeight: number;
  notificationHeight: number;
  welcomeHeight: number;
  goLiveHeight: number;
}

const WINDOW_MARGIN = 24;
const ROOT_PADDING = 8;
const ROW_GAP = 6;
const SMALL_ROW_HEIGHT = 36;
const LARGE_ROW_HEIGHT = 48;
const ROW_MAX_WIDTH = 280;
const WIDGET_MIN_WIDTH = 180;
const NOTIFICATION_ROW_HEIGHT = 32;
const CHAT_ROW_HEIGHT = 72;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Main-process drag bounds; negative monitor coordinates are intentional. */
export function constrainOverlayPosition(position: { x: number; y: number }, size: { width: number; height: number }, area: VoiceOverlayWorkArea): { x: number; y: number } {
  return {
    x: Math.round(clamp(position.x, area.x, area.x + Math.max(0, area.width - size.width))),
    y: Math.round(clamp(position.y, area.y, area.y + Math.max(0, area.height - size.height))),
  };
}

export function normalizeOverlayPosition(position: { x: number; y: number }, size: { width: number; height: number }, area: VoiceOverlayWorkArea): { x: number; y: number } {
  const bounded = constrainOverlayPosition(position, size, area);
  return {
    x: area.width > size.width ? (bounded.x - area.x) / (area.width - size.width) : 0,
    y: area.height > size.height ? (bounded.y - area.y) / (area.height - size.height) : 0,
  };
}

export function restoreOverlayPosition(point: { x: number; y: number }, size: { width: number; height: number }, area: VoiceOverlayWorkArea): { x: number; y: number } {
  return constrainOverlayPosition({ x: area.x + point.x * Math.max(0, area.width - size.width), y: area.y + point.y * Math.max(0, area.height - size.height) }, size, area);
}

/**
 * Compute a bounded overlay window rectangle in screen DIP coordinates.
 * The configured participant count remains an upper bound; physical work-area
 * limits can reduce the effective count without changing user preferences.
 */
export function calculateVoiceOverlayGeometry(
  snapshot: VoiceOverlaySnapshot,
  workArea: VoiceOverlayWorkArea,
): VoiceOverlayWindowGeometry | null {
  if (![workArea.x, workArea.y, workArea.width, workArea.height].every(Number.isFinite) ||
    workArea.width < 1 || workArea.height < 1) return null;

  const marginX = Math.min(WINDOW_MARGIN, Math.floor((workArea.width - 1) / 2));
  const marginY = Math.min(WINDOW_MARGIN, Math.floor((workArea.height - 1) / 2));
  const maxWidth = Math.max(1, Math.floor(workArea.width - marginX * 2));
  const maxHeight = Math.max(1, Math.floor(workArea.height - marginY * 2));

  const goLiveHeight = snapshot.voiceOverlayMode === "game" && snapshot.voiceOverlayGoLive === true && snapshot.goLiveEligible === true && maxWidth >= 196 && maxHeight >= 192 ? 64 : 0;
  const welcomeHeight = snapshot.voiceOverlayWelcome === true && maxWidth >= 196 && maxHeight - goLiveHeight >= 128 ? 32 : 0;
  const contentMaxHeight = maxHeight - welcomeHeight - goLiveHeight;
  const scale = snapshot.scale / 100;
  const rowHeight = snapshot.voiceOverlayAvatarSize === "large" ? LARGE_ROW_HEIGHT : SMALL_ROW_HEIGHT;
  const minimumUsableWidth = Math.ceil(WIDGET_MIN_WIDTH * scale + ROOT_PADDING * 2);
  const hasUsableWidth = maxWidth >= minimumUsableWidth;
  const matchingParticipants = snapshot.participants.filter((participant) => !snapshot.speakingOnly || participant.speaking);
  const requestedCount = Math.min(matchingParticipants.length, snapshot.voiceOverlayMaxParticipants);
  const actionsHeight = snapshot.voiceOverlayQuickActions && snapshot.voiceActionSession && maxWidth >= 112 && contentMaxHeight >= 64 ? 48 : 0;
  const notificationRequestedRows = snapshot.notificationStatus === "ready"
    ? Math.max(1, Math.min(3, snapshot.notifications?.length ?? 0))
    : 1;
  const notificationCapacity = Math.floor((contentMaxHeight - ROOT_PADDING * 2 - actionsHeight - 20) / NOTIFICATION_ROW_HEIGHT);
  const notificationRows = snapshot.voiceOverlayNotifications && maxWidth >= 196 && notificationCapacity >= 1
    ? Math.min(notificationRequestedRows, notificationCapacity)
    : 0;
  const notificationHeight = notificationRows > 0 ? 20 + notificationRows * NOTIFICATION_ROW_HEIGHT : 0;
  const activityCandidate = snapshot.voiceOverlayActivity && maxWidth >= 196;
  const activityMinimum = activityCandidate && contentMaxHeight >= ROOT_PADDING * 2 + actionsHeight + notificationHeight + 60 ? 60 : 0;
  const chatCandidate = snapshot.voiceOverlayChat === true && snapshot.chatStatus !== undefined && maxWidth >= 196;
  const requestedChatRows = snapshot.chatStatus === "ready"
    ? Math.max(1, Math.min(5, snapshot.chatMessages?.length ?? 0))
    : 1;
  const chatCapacity = Math.floor((contentMaxHeight - ROOT_PADDING * 2 - actionsHeight - notificationHeight - activityMinimum - 20) / CHAT_ROW_HEIGHT);
  const chatRows = chatCandidate ? Math.min(requestedChatRows, Math.max(0, chatCapacity)) : 0;
  const chatHeight = chatRows > 0 ? 20 + chatRows * CHAT_ROW_HEIGHT : 0;
  const contentHeightAvailable = Math.max(0, contentMaxHeight - ROOT_PADDING * 2 - actionsHeight - notificationHeight - activityMinimum - chatHeight);
  const rowCapacity = Math.max(0, Math.floor((contentHeightAvailable / scale + ROW_GAP) / (rowHeight + ROW_GAP)));
  const effectiveMaxParticipants = hasUsableWidth
    ? Math.min(snapshot.voiceOverlayMaxParticipants, rowCapacity)
    : 0;
  const visibleParticipants = Math.min(requestedCount, effectiveMaxParticipants);
  const contentHeight = visibleParticipants === 0
    ? 0
    : (visibleParticipants * rowHeight + (visibleParticipants - 1) * ROW_GAP) * scale;
  const activityRows = activityMinimum > 0 ? Math.max(1, Math.min(Math.max(1, snapshot.activities?.length ?? 0), Math.floor((contentMaxHeight - ROOT_PADDING * 2 - actionsHeight - notificationHeight - chatHeight - contentHeight - 20) / 40))) : 0;
  const activityHeight = activityRows > 0 ? 20 + activityRows * 40 : 0;
  const widgetWidth = Math.max(WIDGET_MIN_WIDTH, ROW_MAX_WIDTH) * scale;
  const desiredWidth = Math.ceil(widgetWidth + ROOT_PADDING * 2);
  const desiredHeight = Math.ceil(contentHeight + ROOT_PADDING * 2 + actionsHeight + notificationHeight + activityHeight + chatHeight + welcomeHeight + goLiveHeight);
  const width = clamp(desiredWidth, 1, maxWidth);
  const height = clamp(desiredHeight, 1, maxHeight);

  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  const requestedX = snapshot.position.endsWith("right")
    ? workArea.x + workArea.width - width - marginX
    : workArea.x + marginX;
  const requestedY = snapshot.position.startsWith("bottom")
    ? workArea.y + workArea.height - height - marginY
    : workArea.y + marginY;

  return {
    x: Math.round(clamp(requestedX, minX, maxX)),
    y: Math.round(clamp(requestedY, minY, maxY)),
    width,
    height,
    shouldShow: snapshot.enabled && (visibleParticipants > 0 || actionsHeight > 0 || activityHeight > 0 || notificationHeight > 0 || chatHeight > 0),
    visibleParticipants,
    effectiveMaxParticipants,
    activityVisible: activityHeight > 0,
    activityRows,
    chatVisible: chatHeight > 0,
    chatRows,
    chatHeight,
    notificationsVisible: notificationHeight > 0,
    notificationRows,
    actionsHeight,
    notificationHeight,
    welcomeHeight,
    goLiveHeight,
  };
}
