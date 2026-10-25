import { app, BrowserWindow, screen } from "electron";
import { OverlayWelcomeLifecycle } from "./overlay-welcome";
import { OverlayGameNoticeLifecycle } from "./overlay-game-notices";
import path from "node:path";
import { isTrustedVoiceOverlaySender, VoiceOverlayLifecycle, type VoiceOverlaySnapshot, type OverlayGameActivityNotice } from "./voice-overlay-contract";
import { INBOX_ACTION_HEIGHT, INBOX_ACTION_WIDTH, overlayActionAt, overlayNotificationActionAt, overlayNotificationReplyRowAt, type OverlayAction as OverlayVoiceAction } from "./overlay-action-regions";
import { calculateVoiceOverlayGeometry, constrainOverlayPosition, normalizeOverlayPosition, restoreOverlayPosition, type VoiceOverlayWorkArea } from "./voice-overlay-geometry";
import type { createOverlayLayoutStore, OverlayLayoutContext, OverlayLayoutPoint } from "./overlay-layout-store";
export type { VoiceOverlaySnapshot } from "./voice-overlay-contract";

type TrustedOverlayMainWindow = { isDestroyed(): boolean; webContents: { mainFrame: unknown; send(channel: string, value: unknown): void } };
const mediaLifecycleListeners = new Set<(revoke: boolean) => void>();
export function subscribeVoiceOverlayMediaLifecycle(listener: (revoke: boolean) => void): () => void { mediaLifecycleListeners.add(listener); return () => { mediaLifecycleListeners.delete(listener); }; }
function notifyMediaLifecycle(revoke = false): void { for (const listener of mediaLifecycleListeners) listener(revoke); }
let mediaDocumentUsable = false;
export function getVoiceOverlayMediaWindow() { return mediaDocumentUsable ? overlayWindow : null; }
let overlayWindow: BrowserWindow | null = null;
let latest: VoiceOverlaySnapshot | null = null;
let latestArea: VoiceOverlayWorkArea | null = null;
const lifecycle = new VoiceOverlayLifecycle();
const welcomeLifecycle = new OverlayWelcomeLifecycle();
const goLiveLifecycle = new OverlayWelcomeLifecycle();
let goLiveTimer: ReturnType<typeof setTimeout> | null = null;
let goLiveNoticeSession: string | null = null;
let welcomeTimer: ReturnType<typeof setTimeout> | null = null;
const gameNoticeLifecycle = new OverlayGameNoticeLifecycle();
let gameNoticeTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleGameNoticeExpiry(): void {
  if (gameNoticeTimer) clearTimeout(gameNoticeTimer);
  gameNoticeTimer = null;
  const notices = latest ? gameNoticeLifecycle.current(latest) : [];
  if (!notices.length) return;
  gameNoticeTimer = setTimeout(() => {
    gameNoticeTimer = null;
    if (latest) updateVoiceOverlay({ ...latest, gameActivityNotices: gameNoticeLifecycle.current(latest) }, latestArea ?? undefined, layoutContext);
  }, Math.max(1, Math.min(...notices.map(notice => notice.expiresAt)) - Date.now()));
  gameNoticeTimer.unref?.();
}
/** A main-only clear narrows current content; it never replaces another overlay capability. */
export function clearVoiceOverlayGameNotices(additional: OverlayGameActivityNotice[] = []): void {
  gameNoticeLifecycle.revoke([...(latest?.gameActivityNotices ?? []), ...additional]);
  if (latest) updateVoiceOverlay({ ...latest, gameActivityNotices: [] }, latestArea ?? undefined, layoutContext);
}
function clearWelcome(): void {
  goLiveLifecycle.hide();
  goLiveNoticeSession = null;
  if (goLiveTimer) clearTimeout(goLiveTimer);
  goLiveTimer = null;
  welcomeLifecycle.hide();
  if (welcomeTimer) clearTimeout(welcomeTimer);
  welcomeTimer = null;
}
function publishWelcomeAfterShow(win: BrowserWindow): void {
  if (!latest || win.isDestroyed() || !win.isVisible()) return;
  const notice = welcomeLifecycle.shown(layoutContext, latest.voiceOverlayWelcome === true, Date.now(), latest.overlayNotificationDurationMs);
  if (!notice || welcomeTimer) return;
  welcomeTimer = setTimeout(() => {
    welcomeTimer = null;
    if (win === overlayWindow && !win.isDestroyed() && win.isVisible() && latest) win.webContents.send("voice-overlay-update", voiceOverlayPayload());
  }, Math.max(0, notice.expiresAt - Date.now()));
  welcomeTimer.unref?.();
}
function publishGoLiveAfterShow(win: BrowserWindow): void {
  if (!latest || win.isDestroyed() || !win.isVisible()) return;
  const eligible = process.platform === "win32" && latest.voiceOverlayMode === "game"
    && layoutContext.startsWith("game:") && latest.voiceOverlayGoLive === true && latest.goLiveEligible === true && !!latest.goLiveSession;
  const notice = goLiveLifecycle.shown(layoutContext, eligible, Date.now(), latest.overlayNotificationDurationMs);
  if (!notice || goLiveTimer) return;
  goLiveNoticeSession = latest.goLiveSession ?? null;
  goLiveTimer = setTimeout(() => {
    goLiveTimer = null;
    if (win === overlayWindow && !win.isDestroyed() && win.isVisible() && latest) win.webContents.send("voice-overlay-update", voiceOverlayPayload());
  }, Math.max(0, notice.expiresAt - Date.now()));
  goLiveTimer.unref?.();
}
let unlocked = false;
let layoutPoint: OverlayLayoutPoint | null = null;
let layoutContext: OverlayLayoutContext = "desktop";
let layoutStore: ReturnType<typeof createOverlayLayoutStore> | null = null;
let layoutSaveFailed = false;
let actionWindow: BrowserWindow | null = null;
let notificationActionWindow: BrowserWindow | null = null;
let chatActionWindow: BrowserWindow | null = null;
let chatComposerWindow: BrowserWindow | null = null;
let actionLoadPending = false;
let actionShapeFailed = false;
let notificationActionLoadPending = false;
let notificationActionShapeFailed = false;
let chatActionLoadPending = false;
let chatActionShapeFailed = false;
let pendingNotificationReply: { session: string; notificationId: string; expiresAt: number } | null = null;
let lastReplyActionAt = 0;
let pendingOpenInbox: { session: string; expiresAt: number } | null = null;
let pendingOpenChat: { session: string; expiresAt: number } | null = null;
type ChatSendResult = "sent" | "failed" | "unavailable";
type PendingChatSend = { session: string; requestId: string; resolve: (result: ChatSendResult) => void; timer: ReturnType<typeof setTimeout> };
let pendingChatSend: PendingChatSend | null = null;
const terminalChatRequestIds = new Set<string>();
let chatComposeSessionScope: string | null = null;
let chatComposerMainWindow: TrustedOverlayMainWindow | null = null;
let blockedChatComposeSession: string | null = null;
let mouseIgnored = true;
let lastActionAt = 0;
let lastInboxActionAt = 0;
let lastChatActionAt = 0;
let lastChatComposeActionAt = 0;

function voiceOverlayPayload() {
  if (!latest) return null;
  const geometry = calculateVoiceOverlayGeometry(latest, latestArea ?? screen.getPrimaryDisplay().workArea);
  return { ...latest, mediaHeight: geometry?.mediaHeight ?? 0, goLiveHeight: geometry?.goLiveHeight ?? 0,
    gameActivityNotices: gameNoticeLifecycle.current(latest).slice(0, geometry?.gameActivityNoticeRows ?? 0),
    gameActivityNoticeHeight: geometry?.gameActivityNoticeHeight ?? 0,
    goLive: geometry?.goLiveHeight && latest.voiceOverlayGoLive && latest.goLiveEligible && latest.goLiveSession === goLiveNoticeSession ? goLiveLifecycle.current(Date.now()) : null,
    welcomeHeight: geometry?.welcomeHeight ?? 0,
    welcome: geometry?.welcomeHeight && latest.voiceOverlayWelcome ? welcomeLifecycle.current(Date.now()) : null,
    voiceOverlayMaxParticipants: geometry?.effectiveMaxParticipants ?? 0,
    voiceOverlayActivity: geometry?.activityVisible ?? false,
    activities: geometry?.activityVisible ? (latest.activities ?? []).slice(0, geometry.activityRows) : [],
    voiceOverlayNotifications: geometry?.notificationsVisible ?? false,
    notifications: geometry?.notificationsVisible ? (latest.notifications ?? []).slice(0, geometry.notificationRows) : [],
    voiceOverlayChat: geometry?.chatVisible ?? false,
    chatStatus: geometry?.chatVisible ? latest.chatStatus : undefined,
    chatMessages: geometry?.chatVisible ? (latest.chatMessages ?? []).slice(-geometry.chatRows) : undefined,
    notificationActionsUnavailable: latest.voiceOverlayNotificationActions === true && (notificationActionShapeFailed || process.platform !== "win32"),
    unlocked, layoutSaveFailed, quickActionsUnavailable: actionShapeFailed };
}

function hideActionWindow(): void { if (actionWindow && !actionWindow.isDestroyed()) actionWindow.hide(); }
function setMouseIgnored(ignore: boolean): void {
  if (!overlayWindow || overlayWindow.isDestroyed() || mouseIgnored === ignore) return;
  mouseIgnored = ignore;
  if (ignore) overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  else overlayWindow.setIgnoreMouseEvents(false);
}
function actionAvailable(): boolean {
  return latest?.voiceOverlayCompatibility !== true && !!latest?.enabled && latest.voiceOverlayQuickActions === true && !!latest.voiceActionSession
    && !!overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
}
function notificationActionAvailable(): boolean {
  const geometry = latest && calculateVoiceOverlayGeometry(latest, latestArea ?? screen.getPrimaryDisplay().workArea);
  return latest?.voiceOverlayCompatibility !== true && !!latest?.enabled && latest.voiceOverlayNotifications === true && latest.voiceOverlayNotificationActions === true
    && latest.notificationStatus === "ready" && (latest.notifications?.length ?? 0) > 0
    && !!latest.notificationActionSession && !!geometry?.notificationsVisible
    && !!overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()
    && process.platform === "win32" && !notificationActionShapeFailed;
}

function chatActionAvailable(): boolean {
  const geometry = latest && calculateVoiceOverlayGeometry(latest, latestArea ?? screen.getPrimaryDisplay().workArea);
  return latest?.voiceOverlayCompatibility !== true && !!latest?.enabled && latest.voiceOverlayChat === true && latest.voiceOverlayChatActions === true
    && latest.chatStatus === "ready" && !!latest.chatActionSession && !!geometry?.chatVisible
    && !!overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()
    && process.platform === "win32" && !chatActionShapeFailed;
}

function chatComposeAvailable(): boolean {
  return chatActionAvailable() && latest?.voiceOverlayChatCompose === true && !!latest.chatComposeSession;
}

function cancelPendingChatSend(result: ChatSendResult = "unavailable"): void {
  const pending = pendingChatSend;
  if (!pending) return;
  pendingChatSend = null;
  clearTimeout(pending.timer);
  pending.resolve(result);
}

function closeChatComposerWindow(): void {
  terminalChatRequestIds.clear();
  cancelPendingChatSend("unavailable");
  const current = chatComposerWindow;
  if (current && !current.isDestroyed()) {
    if (chatComposeSessionScope) blockedChatComposeSession = chatComposeSessionScope;
    current.close();
  }
  else {
    chatComposerWindow = null;
    chatComposeSessionScope = null;
    chatComposerMainWindow = null;
  }
}

function deliverChatComposerSnapshot(target: BrowserWindow, session: string, focus: boolean): void {
  if (target !== chatComposerWindow || target.isDestroyed() || !chatComposeAvailable() || chatComposeSessionScope !== session) {
    if (!target.isDestroyed()) target.close();
    return;
  }
  // Keep this surface minimal: only its grant and current verified label cross over.
  target.webContents.send("voice-overlay-update", {
    enabled: true, voiceOverlayChatCompose: true, chatComposeSession: session,
    chatComposeLabel: latest!.chatComposeLabel,
  });
  if (focus) { target.show(); target.focus(); }
}

function openChatComposer(session: string, mainWindow: TrustedOverlayMainWindow): boolean {
  if (!chatComposeAvailable() || session !== latest?.chatComposeSession || blockedChatComposeSession === session || !overlayWindow || overlayWindow.isDestroyed()
    || mainWindow.isDestroyed()) return false;
  if (chatComposerWindow && !chatComposerWindow.isDestroyed()) {
    if (chatComposeSessionScope !== session || chatComposerMainWindow !== mainWindow) { closeChatComposerWindow(); return false; }
    else { chatComposerWindow.show(); chatComposerWindow.focus(); return true; }
  }
  const workArea = latestArea ?? screen.getPrimaryDisplay().workArea;
  const width = Math.max(1, Math.min(360, workArea.width));
  const height = Math.max(1, Math.min(280, workArea.height));
  const x = Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, overlayWindow.getBounds().x + overlayWindow.getBounds().width - width));
  const y = Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, overlayWindow.getBounds().y + overlayWindow.getBounds().height - height));
  const created = new BrowserWindow({ width, height, x, y, frame: false, transparent: true, resizable: false, alwaysOnTop: true, focusable: true, skipTaskbar: true, hasShadow: true, show: false, parent: overlayWindow, webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  chatComposerWindow = created;
  chatComposeSessionScope = session;
  chatComposerMainWindow = mainWindow;
  terminalChatRequestIds.clear();
  let initialLoadComplete = false;
  created.setAlwaysOnTop(true, "floating");
  created.webContents.on("did-start-navigation", (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
    if (initialLoadComplete && isMainFrame && !isInPlace && chatComposerWindow === created) closeChatComposerWindow();
  });
  created.on("closed", () => {
    if (chatComposerWindow === created) {
      chatComposerWindow = null;
      chatComposeSessionScope = null;
      blockedChatComposeSession = session;
      terminalChatRequestIds.clear();
      cancelPendingChatSend("unavailable");
      const parent = chatComposerMainWindow;
      chatComposerMainWindow = null;
      if (parent && !parent.isDestroyed()) {
        try { parent.webContents.send("overlay-chat-composer-closed", { session }); } catch { /* The parent may be closing at the same time. */ }
      }
    }
  });
  const dev = process.env.NODE_ENV === "development" || !app.isPackaged;
  void created.loadURL(dev ? "http://localhost:3030/overlay.html?surface=chat-composer" : "app://hichat/overlay.html?surface=chat-composer")
    .catch(() => { if (chatComposerWindow === created) closeChatComposerWindow(); });
  const deliver = () => {
    initialLoadComplete = true;
    deliverChatComposerSnapshot(created, session, true);
  };
  if (created.webContents.isLoading()) created.webContents.once("did-finish-load", deliver);
  else deliver();
  return true;
}

function hideNotificationActionWindow(): void { pendingNotificationReply = null;
  pendingOpenInbox = null;
  if (notificationActionWindow && !notificationActionWindow.isDestroyed()) notificationActionWindow.hide();
}

function hideChatActionWindow(): void {
  pendingOpenChat = null;
  closeChatComposerWindow();
  if (chatActionWindow && !chatActionWindow.isDestroyed()) {
    try {
      chatActionWindow.webContents.send("voice-overlay-update", {
        enabled: false, voiceOverlayChat: false, voiceOverlayChatActions: false,
        chatMessages: undefined, chatActionSession: undefined, participants: [],
      });
    } catch { /* A closing child is already unable to act; the main scope is revoked regardless. */ }
    chatActionWindow.hide();
  }
}

function updateChatActionWindow(): void {
  if (!chatActionAvailable()) { hideChatActionWindow(); return; }
  const expanded = chatComposeAvailable();
  const actionWidth = expanded ? 184 : 88;
  if (!chatActionWindow || chatActionWindow.isDestroyed()) {
    const created = new BrowserWindow({ width: actionWidth, height: 20, frame: false, transparent: true, resizable: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, hasShadow: false, show: false, parent: overlayWindow!, webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    chatActionWindow = created;
    try {
      created.setShape(expanded
        ? [{ x: 0, y: 0, width: 88, height: 20 }, { x: 96, y: 0, width: 88, height: 20 }]
        : [{ x: 0, y: 0, width: 88, height: 20 }]);
    } catch {
      chatActionShapeFailed = true;
      pendingOpenChat = null;
      created.close(); chatActionWindow = null;
      overlayWindow!.webContents.send("voice-overlay-update", voiceOverlayPayload());
      return;
    }
    created.setAlwaysOnTop(true, "floating");
    created.on("closed", () => { if (chatActionWindow === created) { chatActionWindow = null; chatActionLoadPending = false; pendingOpenChat = null; } });
    const dev = process.env.NODE_ENV === "development" || !app.isPackaged;
    void created.loadURL(dev ? "http://localhost:3030/overlay.html?surface=chat-actions" : "app://hichat/overlay.html?surface=chat-actions");
  }
  const target = chatActionWindow;
  const deliver = () => {
    if (target !== chatActionWindow || target.isDestroyed() || !chatActionAvailable()) { if (!target.isDestroyed()) target.hide(); return; }
    if (chatComposerWindow && !chatComposerWindow.isDestroyed() && (!chatComposeAvailable() || chatComposeSessionScope !== latest!.chatComposeSession)) closeChatComposerWindow();
    const bounds = overlayWindow!.getBounds();
    // Chat is the upper panel; its open control sits inside the header, while
    // the voice and activity hit regions remain anchored to the lower edge.
    target.setSize(actionWidth, 20, false);
    try {
      target.setShape(expanded
        ? [{ x: 0, y: 0, width: 88, height: 20 }, { x: 96, y: 0, width: 88, height: 20 }]
        : [{ x: 0, y: 0, width: 88, height: 20 }]);
    } catch {
      chatActionShapeFailed = true;
      pendingOpenChat = null;
      closeChatComposerWindow();
      target.hide();
      overlayWindow!.webContents.send("voice-overlay-update", voiceOverlayPayload());
      return;
    }
    target.setPosition(bounds.x + bounds.width - 8 - actionWidth, bounds.y + 8, false);
    // The child receives only the action-session token and empty panel defaults.
    target.webContents.send("voice-overlay-update", {
      enabled: true, voiceOverlayChat: true, voiceOverlayChatActions: true,
      chatStatus: "ready", chatMessages: [], chatActionSession: latest!.chatActionSession,
      voiceOverlayChatCompose: expanded, chatComposeSession: expanded ? latest!.chatComposeSession : undefined,
      participants: [], voiceOverlayNotifications: false, notifications: [], notificationStatus: undefined,
      notificationActionSession: undefined,
    });
    target.showInactive();
  };
  if (target.webContents.isLoading()) {
    if (!chatActionLoadPending) {
      chatActionLoadPending = true;
      target.webContents.once("did-finish-load", () => { if (target === chatActionWindow) chatActionLoadPending = false; deliver(); });
    }
  } else deliver();
}

function updateNotificationActionWindow(): void {
  if (!notificationActionAvailable()) { hideNotificationActionWindow(); return; }
  if (!notificationActionWindow || notificationActionWindow.isDestroyed()) {
    const created = new BrowserWindow({ width: INBOX_ACTION_WIDTH, height: INBOX_ACTION_HEIGHT, frame: false, transparent: true, resizable: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, hasShadow: false, show: false, parent: overlayWindow!, webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    notificationActionWindow = created;
    try {
      created.setShape([{ x: 0, y: 0, width: INBOX_ACTION_WIDTH, height: INBOX_ACTION_HEIGHT }]);
    } catch {
      notificationActionShapeFailed = true;
      pendingOpenInbox = null; pendingNotificationReply = null;
      created.close(); notificationActionWindow = null;
      overlayWindow!.webContents.send("voice-overlay-update", voiceOverlayPayload());
      return;
    }
    created.setAlwaysOnTop(true, "floating");
    created.on("closed", () => { if (notificationActionWindow === created) { notificationActionWindow = null; notificationActionLoadPending = false; pendingOpenInbox = null; pendingNotificationReply = null; } });
    const dev = process.env.NODE_ENV === "development" || !app.isPackaged;
    void created.loadURL(dev ? "http://localhost:3030/overlay.html?surface=notification-actions" : "app://hichat/overlay.html?surface=notification-actions");
  }
  const target = notificationActionWindow;
  const deliver = () => {
    if (target !== notificationActionWindow || target.isDestroyed() || !notificationActionAvailable()) { pendingNotificationReply = null; if (!target.isDestroyed()) target.hide(); return; }
    const bounds = overlayWindow!.getBounds();
    const geometry = calculateVoiceOverlayGeometry(latest!, latestArea ?? screen.getPrimaryDisplay().workArea);
    if (!geometry || !geometry.notificationsVisible) { target.hide(); pendingOpenInbox = null; pendingNotificationReply = null; return; }
    const notificationHeight = 20 + geometry.notificationRows * 32;
    target.setPosition(bounds.x + bounds.width - 8 - INBOX_ACTION_WIDTH,
      bounds.y + bounds.height - 8 - geometry.actionsHeight - notificationHeight, false);
    const replyButtons = (latest!.notifications ?? []).slice(0, geometry.notificationRows)
      .map((item, row) => ({ id: item.id, row })).filter(item => latest!.notificationReplyIds?.includes(item.id));
    target.setSize(INBOX_ACTION_WIDTH, notificationHeight, false);
    try {
      target.setShape([{ x: 0, y: 0, width: 88, height: 20 }, ...replyButtons.map(item => ({ x: 0, y: 20 + item.row * 32 + 6, width: 88, height: 20 }))]);
    } catch {
      notificationActionShapeFailed = true; pendingNotificationReply = null; pendingOpenInbox = null;
      target.hide(); overlayWindow!.webContents.send("voice-overlay-update", voiceOverlayPayload()); return;
    }
    // Only bounded opaque IDs, row indexes and session tokens reach this existing child.
    // No actor, conversation identifier, message body or route is forwarded.
    target.webContents.send("voice-overlay-update", {
      enabled: true, voiceOverlayNotifications: true, voiceOverlayNotificationActions: true,
      notificationActionSession: latest!.notificationActionSession, participants: [],
      notificationReplySession: latest!.notificationReplySession, notificationReplyButtons: replyButtons,
      voiceOverlayChat: false, voiceOverlayChatActions: false, voiceOverlayChatCompose: false, chatStatus: undefined, chatMessages: undefined, chatActionSession: undefined, chatComposeSession: undefined, chatComposeLabel: undefined,
    });
    target.showInactive();
  };
  if (target.webContents.isLoading()) {
    if (!notificationActionLoadPending) {
      notificationActionLoadPending = true;
      target.webContents.once("did-finish-load", () => { if (target === notificationActionWindow) notificationActionLoadPending = false; deliver(); });
    }
  } else deliver();
}

function updateMousePolicy(): void {
  setMouseIgnored(latest?.voiceOverlayCompatibility === true || !unlocked);
  if (!actionAvailable() || (!unlocked && latest?.voiceOverlayClickableActions !== true) || process.platform !== "win32" || actionShapeFailed) { hideActionWindow(); return; }
  if (!actionWindow || actionWindow.isDestroyed()) {
    const created = new BrowserWindow({ width: 88, height: 40, frame: false, transparent: true, resizable: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, hasShadow: false, show: false, parent: overlayWindow!, webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    actionWindow = created;
    try {
      // Native shape governs drawing AND hit testing. The 8-DIP gap is not a window region.
      created.setShape([{ x: 0, y: 0, width: 40, height: 40 }, { x: 48, y: 0, width: 40, height: 40 }]);
    } catch {
      actionShapeFailed = true;
      created.close(); actionWindow = null;
      overlayWindow!.webContents.send("voice-overlay-update", voiceOverlayPayload());
      return;
    }
    created.setAlwaysOnTop(true, "floating");
    created.on("closed", () => { if (actionWindow === created) { actionWindow = null; actionLoadPending = false; } });
    const dev = process.env.NODE_ENV === "development" || !app.isPackaged;
    void created.loadURL(dev ? "http://localhost:3030/overlay.html?surface=actions" : "app://hichat/overlay.html?surface=actions");
  }
  const target = actionWindow;
  const deliver = () => {
    if (target !== actionWindow || target.isDestroyed() || !actionAvailable() || (!unlocked && latest?.voiceOverlayClickableActions !== true)) { if (!target.isDestroyed()) target.hide(); return; }
    const bounds = overlayWindow!.getBounds();
    target.setPosition(bounds.x + bounds.width - 96, bounds.y + bounds.height - 48, false);
    target.webContents.send("voice-overlay-update", { ...latest, participants: [], activities: [], voiceOverlayActivity: false, voiceOverlayNotifications: false, voiceOverlayNotificationActions: false, notificationActionSession: undefined, notifications: [], notificationStatus: undefined, voiceOverlayChat: false, voiceOverlayChatActions: false, voiceOverlayChatCompose: false, chatStatus: undefined, chatMessages: undefined, chatActionSession: undefined, chatComposeSession: undefined, chatComposeLabel: undefined, unlocked });
    target.showInactive();
  };
  if (target.webContents.isLoading()) {
    if (!actionLoadPending) { actionLoadPending = true; target.webContents.once("did-finish-load", () => { if (target === actionWindow) actionLoadPending = false; deliver(); }); }
  } else deliver();
}

export function takeVoiceOverlayAction(event: { sender: unknown; senderFrame: unknown }, action: unknown, session: unknown): { action: OverlayVoiceAction; session: string } | null {
  const trusted = (unlocked && isTrustedVoiceOverlaySender(event, overlayWindow)) || (actionWindow && !actionWindow.isDestroyed() && actionWindow.isVisible() && isTrustedVoiceOverlaySender(event, actionWindow));
  if (!trusted || !actionAvailable() || typeof session !== "string"
    || session !== latest?.voiceActionSession || (!unlocked && latest?.voiceOverlayClickableActions !== true)) return null;
  const win = overlayWindow!;
  let hit: OverlayVoiceAction | null = null;
  try { hit = overlayActionAt(screen.getCursorScreenPoint(), win.getBounds(), true); } catch { return null; }
  if (!hit || hit !== action || Date.now() - lastActionAt < 250) return null;
  lastActionAt = Date.now();
  return { action: hit, session };
}

/** The action child can only request a generic inbox open for its exact button. */
export function takeVoiceOverlayOpenInboxIntent(event: { sender: unknown; senderFrame: unknown }, session: unknown): { session: string } | null {
  const win = notificationActionWindow;
  if (!win || win.isDestroyed() || !win.isVisible() || !isTrustedVoiceOverlaySender(event, win)
    || !notificationActionAvailable() || typeof session !== "string" || session !== latest?.notificationActionSession) return null;
  let hit: string | null = null;
  try { hit = overlayNotificationActionAt(screen.getCursorScreenPoint(), win.getBounds(), true); } catch { return null; }
  if (hit !== "open-inbox" || Date.now() - lastInboxActionAt < 250) return null;
  lastInboxActionAt = Date.now();
  pendingOpenInbox = { session, expiresAt: Date.now() + 5000 };
  return { session };
}

/** Consume a one-shot click only after the main renderer revalidates its account scope. */
export function confirmVoiceOverlayOpenInbox(
  event: { sender: unknown; senderFrame: unknown },
  session: unknown,
  mainWindow: {
    isDestroyed(): boolean;
    isMinimized(): boolean;
    restore(): void;
    show(): void;
    focus(): void;
    webContents: { mainFrame: unknown };
  } | null,
): boolean {
  if (!mainWindow || !isTrustedVoiceOverlaySender(event, mainWindow)) return false;
  const pending = pendingOpenInbox;
  pendingOpenInbox = null;
  const accepted = !!pending && !!notificationActionWindow && !notificationActionWindow.isDestroyed() && notificationActionWindow.isVisible()
    && pending.expiresAt >= Date.now() && typeof session === "string"
    && session === pending.session && session === latest?.notificationActionSession
    && notificationActionAvailable();
  if (!accepted) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return true;
}

export type OverlayNotificationReplyRequest = { session: string; notificationId: string };
function parseNotificationReplyRequest(raw: unknown): OverlayNotificationReplyRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || !Object.hasOwnProperty.call(value, "session") || !Object.hasOwnProperty.call(value, "notificationId")) return null;
  if (!isChatRequestToken(value.session, 256) || !isChatRequestToken(value.notificationId, 128)) return null;
  return { session: value.session, notificationId: value.notificationId };
}
function notificationReplyAvailable(request: OverlayNotificationReplyRequest): boolean {
  if (!notificationActionAvailable() || request.session !== latest?.notificationReplySession
    || !latest.notificationReplyIds?.includes(request.notificationId)) return false;
  const geometry = calculateVoiceOverlayGeometry(latest, latestArea ?? screen.getPrimaryDisplay().workArea);
  return !!geometry && (latest.notifications ?? []).slice(0, geometry.notificationRows)
    .some(item => item.id === request.notificationId && (item.category === "mention" || item.category === "reply"));
}

/** Exact physical row only; the child cannot supply a conversation or URL. */
export function takeVoiceOverlayNotificationReplyIntent(event: { sender: unknown; senderFrame: unknown }, raw: unknown): OverlayNotificationReplyRequest | null {
  const request = parseNotificationReplyRequest(raw), win = notificationActionWindow;
  if (!request || !win || win.isDestroyed() || !win.isVisible() || !isTrustedVoiceOverlaySender(event, win)
    || !notificationReplyAvailable(request) || Date.now() - lastReplyActionAt < 250) return null;
  const geometry = calculateVoiceOverlayGeometry(latest!, latestArea ?? screen.getPrimaryDisplay().workArea);
  let row: number | null;
  try { row = overlayNotificationReplyRowAt(screen.getCursorScreenPoint(), win.getBounds(), geometry!.notificationRows); } catch { return null; }
  if (row === null || latest?.notifications?.[row]?.id !== request.notificationId) return null;
  lastReplyActionAt = Date.now();
  pendingNotificationReply = { ...request, expiresAt: Date.now() + 5000 };
  return request;
}

/** Main renderer revalidates source access before consuming this one-shot focus intent. */
export function confirmVoiceOverlayNotificationReply(event: { sender: unknown; senderFrame: unknown }, raw: unknown,
  mainWindow: { isDestroyed(): boolean; isMinimized(): boolean; restore(): void; show(): void; focus(): void; webContents: { mainFrame: unknown } } | null): boolean {
  if (!mainWindow || !isTrustedVoiceOverlaySender(event, mainWindow)) return false;
  const pending = pendingNotificationReply, request = parseNotificationReplyRequest(raw);
  pendingNotificationReply = null;
  if (!request || !pending || pending.expiresAt < Date.now() || request.session !== pending.session
    || request.notificationId !== pending.notificationId || !notificationReplyAvailable(request)
    || !notificationActionWindow || notificationActionWindow.isDestroyed() || !notificationActionWindow.isVisible()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus(); return true;
}

/** The chat child can request only the generic current-channel view. */
export function takeVoiceOverlayOpenChatIntent(event: { sender: unknown; senderFrame: unknown }, session: unknown): { session: string } | null {
  const win = chatActionWindow;
  if (!win || win.isDestroyed() || !win.isVisible() || !isTrustedVoiceOverlaySender(event, win)
    || !chatActionAvailable() || typeof session !== "string" || session !== latest?.chatActionSession) return null;
  let hit = false;
  try {
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    hit = cursor.x >= bounds.x && cursor.x < bounds.x + 88 && cursor.y >= bounds.y && cursor.y < bounds.y + 20;
  } catch { return null; }
  if (!hit || Date.now() - lastChatActionAt < 250) return null;
  lastChatActionAt = Date.now();
  pendingOpenChat = { session, expiresAt: Date.now() + 5000 };
  return { session };
}

/** The compose button is a separate shaped region and requires its own consent token. */
export function takeVoiceOverlayOpenChatComposerIntent(event: { sender: unknown; senderFrame: unknown }, session: unknown, mainWindow: TrustedOverlayMainWindow | null): { session: string } | null {
  const win = chatActionWindow;
  if (!win || win.isDestroyed() || !win.isVisible() || !isTrustedVoiceOverlaySender(event, win)
    || !chatComposeAvailable() || typeof session !== "string" || session !== latest?.chatComposeSession
    || !mainWindow || mainWindow.isDestroyed()) return null;
  let hit = false;
  try {
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    hit = cursor.x >= bounds.x && cursor.x < bounds.x + 88 && cursor.y >= bounds.y && cursor.y < bounds.y + 20;
  } catch { return null; }
  if (!hit || Date.now() - lastChatComposeActionAt < 250) return null;
  lastChatComposeActionAt = Date.now();
  return openChatComposer(session, mainWindow) ? { session } : null;
}

export type OverlayChatSendRequest = { session: string; requestId: string; text: string };
export type OverlayChatSendResult = ChatSendResult;

function isChatRequestToken(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** Sends plaintext only to the trusted main renderer and awaits its scoped result. */
export function sendOverlayChatMessage(event: { sender: unknown; senderFrame: unknown }, raw: unknown, mainWindow: TrustedOverlayMainWindow | null): Promise<ChatSendResult> {
  const win = chatComposerWindow;
  if (!win || win.isDestroyed() || !win.isVisible() || !isTrustedVoiceOverlaySender(event, win) || !chatComposeAvailable()) return Promise.resolve("unavailable");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return Promise.resolve("failed");
  const request = raw as Record<string, unknown>;
  if (Object.keys(request).length !== 3 || !["session", "requestId", "text"].every((key) => Object.prototype.hasOwnProperty.call(request, key))) return Promise.resolve("failed");
  const { session, requestId, text } = request;
  if (typeof session !== "string" || session !== latest?.chatComposeSession || session !== chatComposeSessionScope
    || !isChatRequestToken(requestId, 128) || typeof text !== "string" || text.trim().length === 0 || text.length > 2000
    || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)) return Promise.resolve("failed");
  if (terminalChatRequestIds.has(requestId) || terminalChatRequestIds.size >= 64 || pendingChatSend) return Promise.resolve("unavailable");
  if (!mainWindow || mainWindow !== chatComposerMainWindow || !isTrustedVoiceOverlaySender({ sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame }, mainWindow)) return Promise.resolve("unavailable");
  terminalChatRequestIds.add(requestId);
  return new Promise<ChatSendResult>((resolve) => {
    const pending: PendingChatSend = {
      session, requestId, resolve,
      timer: setTimeout(() => {
        if (pendingChatSend !== pending) return;
        pendingChatSend = null;
        resolve("failed");
      }, 5000),
    };
    pendingChatSend = pending;
    try {
      mainWindow.webContents.send("overlay-chat-send", { session, requestId, text });
    } catch {
      pendingChatSend = null;
      clearTimeout(pending.timer);
      resolve("unavailable");
    }
  });
}

/** Only the current trusted main frame can settle the exact in-flight send. */
export function resolveOverlayChatSend(event: { sender: unknown; senderFrame: unknown }, raw: unknown, mainWindow: TrustedOverlayMainWindow | null): boolean {
  if (mainWindow !== chatComposerMainWindow || !isTrustedVoiceOverlaySender(event, mainWindow) || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || !["session", "requestId", "result"].every((key) => Object.prototype.hasOwnProperty.call(value, key))) return false;
  const pending = pendingChatSend;
  if (!pending || value.session !== pending.session || value.session !== latest?.chatComposeSession
    || value.requestId !== pending.requestId || !["sent", "failed", "unavailable"].includes(value.result as string)
    || !chatComposeAvailable() || chatComposeSessionScope !== pending.session) return false;
  pendingChatSend = null;
  clearTimeout(pending.timer);
  pending.resolve(value.result as ChatSendResult);
  return true;
}

/** The composer may close only its own current session. */
export function closeOverlayChatComposer(event: { sender: unknown; senderFrame: unknown }, session: unknown): boolean {
  const win = chatComposerWindow;
  if (!win || win.isDestroyed() || !isTrustedVoiceOverlaySender(event, win) || typeof session !== "string"
    || session !== chatComposeSessionScope || session !== latest?.chatComposeSession) return false;
  closeChatComposerWindow();
  return true;
}

/** Focus the app only after its trusted renderer revalidates channel access. */
export function confirmVoiceOverlayOpenChat(
  event: { sender: unknown; senderFrame: unknown },
  session: unknown,
  mainWindow: {
    isDestroyed(): boolean;
    isMinimized(): boolean;
    restore(): void;
    show(): void;
    focus(): void;
    webContents: { mainFrame: unknown };
  } | null,
): boolean {
  if (!mainWindow || !isTrustedVoiceOverlaySender(event, mainWindow)) return false;
  const pending = pendingOpenChat;
  pendingOpenChat = null;
  const accepted = !!pending && !!chatActionWindow && !chatActionWindow.isDestroyed() && chatActionWindow.isVisible()
    && pending.expiresAt >= Date.now() && typeof session === "string"
    && session === pending.session && session === latest?.chatActionSession && chatActionAvailable();
  if (!accepted) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return true;
}

export function configureVoiceOverlayLayout(store: ReturnType<typeof createOverlayLayoutStore>): void {
  layoutStore = store;
  layoutPoint = store.get(layoutContext);
}

function rememberPosition(): void {
  const win = overlayWindow;
  if (!unlocked || !win || win.isDestroyed() || !latest) return;
  const area = latestArea ?? screen.getPrimaryDisplay().workArea;
  const geometry = calculateVoiceOverlayGeometry(latest, area);
  if (!geometry?.shouldShow) return;
  const [x, y] = win.getPosition();
  layoutPoint = normalizeOverlayPosition({ x, y }, geometry, area);
  layoutSaveFailed = layoutStore ? !layoutStore.set(layoutContext, layoutPoint) : false;
}

export function lockVoiceOverlay(): void {
  rememberPosition();
  unlocked = false;
  updateMousePolicy();
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (latest) overlayWindow.webContents.send("voice-overlay-update", voiceOverlayPayload());
}

export function resetVoiceOverlayLayout(): boolean {
  if (!layoutStore?.reset()) return false;
  unlocked = false; // Reset must not re-save the location it just removed.
  layoutPoint = null;
  layoutSaveFailed = false;
  lockVoiceOverlay();
  if (latest) updateVoiceOverlay({ ...latest, position: "center-left", scale: 100 }, latestArea ?? undefined, layoutContext);
  return true;
}

/** Unlock only a visible, authorized widget; never activate/focus its window. */
export function toggleVoiceOverlayLock(): void {
  const win = overlayWindow;
  if (!win || win.isDestroyed() || !win.isVisible() || !latest?.enabled || latest.voiceOverlayPinned || latest.voiceOverlayCompatibility === true) return;
  if (unlocked) {
    lockVoiceOverlay();
  } else {
    unlocked = true;
    updateMousePolicy();
    win.webContents.send("voice-overlay-update", voiceOverlayPayload());
  }
}

function ensureOverlay(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  overlayWindow = new BrowserWindow({
    width: 300, height: 420, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, focusable: false, skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  overlayWindow.setAlwaysOnTop(true, "floating");
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  mouseIgnored = true;
  const createdWindow = overlayWindow;
  createdWindow.on("will-move", (event, bounds) => {
    if (!latestArea || latest?.voiceOverlayMode !== "game") return;
    const constrained = constrainOverlayPosition(bounds, bounds, latestArea);
    if (constrained.x !== bounds.x || constrained.y !== bounds.y) {
      event.preventDefault();
      createdWindow.setPosition(constrained.x, constrained.y, false);
    }
  });
  createdWindow.on("move", () => { updateMousePolicy(); updateNotificationActionWindow(); updateChatActionWindow(); });
  createdWindow.on("hide", () => { if(createdWindow===overlayWindow)notifyMediaLifecycle(); clearWelcome(); hideActionWindow(); hideNotificationActionWindow(); hideChatActionWindow(); });
  createdWindow.webContents.on("did-finish-load", () => { if (createdWindow === overlayWindow) { mediaDocumentUsable = true; notifyMediaLifecycle(); } });
  createdWindow.webContents.on("render-process-gone", () => { if(createdWindow===overlayWindow){mediaDocumentUsable = false; notifyMediaLifecycle(true);} });
  createdWindow.webContents.on("did-start-navigation", (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean) => { if (createdWindow===overlayWindow && isMainFrame && !isInPlace) { mediaDocumentUsable = false; notifyMediaLifecycle(true); } });
  createdWindow.on("closed", () => {
    if (overlayWindow === createdWindow) {
      mediaDocumentUsable = false; notifyMediaLifecycle(true);
      lifecycle.close();
      clearWelcome();
      latest = null;
      if (gameNoticeTimer) clearTimeout(gameNoticeTimer);
      gameNoticeTimer = null;
      unlocked = false;
      layoutPoint = null;
      if (actionWindow && !actionWindow.isDestroyed()) actionWindow.close();
      actionWindow = null;
      actionLoadPending = false;
      if (notificationActionWindow && !notificationActionWindow.isDestroyed()) notificationActionWindow.close();
      notificationActionWindow = null;
      notificationActionLoadPending = false;
      if (chatActionWindow && !chatActionWindow.isDestroyed()) chatActionWindow.close();
      chatActionWindow = null;
      chatActionLoadPending = false;
      closeChatComposerWindow();
      pendingOpenInbox = null;
      pendingOpenChat = null;
      overlayWindow = null;
    }
  });
  const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
  void overlayWindow.loadURL(isDev ? "http://localhost:3030/overlay.html" : "app://hichat/overlay.html");
  return overlayWindow;
}

export function updateVoiceOverlay(snapshot: VoiceOverlaySnapshot, area?: VoiceOverlayWorkArea, context?: string): void {
  snapshot = { ...snapshot, gameActivityNotices: gameNoticeLifecycle.current(snapshot) };
  // Compatibility is a real passive native policy, not a renderer-only preference.
  const compatibility = snapshot.voiceOverlayCompatibility === true;
  const compatibilityChanged = compatibility !== (latest?.voiceOverlayCompatibility === true);
  if (compatibilityChanged) {
    rememberPosition(); unlocked = false;
    pendingOpenInbox = null; pendingOpenChat = null; pendingNotificationReply = null;
    closeChatComposerWindow();
    hideActionWindow(); hideNotificationActionWindow(); hideChatActionWindow();
    setMouseIgnored(true);
  }
  if (compatibility) snapshot = { ...snapshot, voiceOverlayClickableActions: false, voiceOverlayNotificationActions: false, voiceOverlayChatActions: false, voiceOverlayChatCompose: false };
  if (process.platform !== "win32") snapshot = { ...snapshot, goLiveEligible: false };
  if (!snapshot.voiceOverlayGoLive || !snapshot.goLiveEligible || !snapshot.goLiveSession || (latest !== null && latest.goLiveSession !== snapshot.goLiveSession)) {
    goLiveLifecycle.dismiss();
    if (goLiveTimer) clearTimeout(goLiveTimer);
    goLiveTimer = null;
  }
  if (!snapshot.enabled) clearWelcome();
  if (!snapshot.enabled || !snapshot.voiceOverlayQuickActions) actionShapeFailed = false;
  if (!snapshot.enabled || !snapshot.voiceOverlayNotifications || !snapshot.voiceOverlayNotificationActions || !snapshot.notificationActionSession) notificationActionShapeFailed = false;
  if (!snapshot.enabled || !snapshot.voiceOverlayChat || !snapshot.voiceOverlayChatActions || !snapshot.chatActionSession) chatActionShapeFailed = false;
  const nextContext = (context ?? (snapshot.voiceOverlayMode === "game" ? layoutContext : "desktop")) as OverlayLayoutContext;
  const contextChanged = nextContext !== layoutContext;
  const cornerChanged = latest !== null && latest.position !== snapshot.position;
  const nextGeometry = calculateVoiceOverlayGeometry(snapshot, area ?? screen.getPrimaryDisplay().workArea);
  if (contextChanged) clearWelcome();
  if (contextChanged || cornerChanged || snapshot.voiceOverlayPinned || !nextGeometry?.shouldShow) lockVoiceOverlay();
  if (contextChanged || latest === null) {
    layoutContext = nextContext;
    layoutPoint = layoutStore?.get(layoutContext) ?? null;
  }
  if (cornerChanged && !contextChanged) {
    const removed = layoutStore?.remove(layoutContext) ?? true;
    layoutSaveFailed = !removed;
    if (removed) layoutPoint = null;
  }
  if (unlocked && area && (!latestArea || area.x !== latestArea.x || area.y !== latestArea.y || area.width !== latestArea.width || area.height !== latestArea.height)) lockVoiceOverlay();
  if (pendingNotificationReply && (pendingNotificationReply.session !== snapshot.notificationReplySession || !snapshot.notificationReplyIds?.includes(pendingNotificationReply.notificationId))) pendingNotificationReply = null;
  if (pendingOpenInbox && pendingOpenInbox.session !== snapshot.notificationActionSession) pendingOpenInbox = null;
  if (pendingOpenChat && pendingOpenChat.session !== snapshot.chatActionSession) pendingOpenChat = null;
  if (blockedChatComposeSession && blockedChatComposeSession !== snapshot.chatComposeSession) blockedChatComposeSession = null;
  if (chatComposerWindow && !chatComposerWindow.isDestroyed() &&
    (!snapshot.enabled || snapshot.voiceOverlayChat !== true || snapshot.voiceOverlayChatActions !== true
      || snapshot.voiceOverlayChatCompose !== true || snapshot.chatStatus !== "ready"
      || !snapshot.chatComposeSession || snapshot.chatComposeSession !== chatComposeSessionScope)) closeChatComposerWindow();
  latest = snapshot;
  scheduleGameNoticeExpiry();
  notifyMediaLifecycle(contextChanged);
  latestArea = area ?? null;
  if (chatComposerWindow && !chatComposerWindow.isDestroyed()) {
    if (!chatComposeAvailable() || chatComposeSessionScope !== snapshot.chatComposeSession) closeChatComposerWindow();
    else if (!chatComposerWindow.webContents.isLoading()) deliverChatComposerSnapshot(chatComposerWindow, chatComposeSessionScope, false);
  }
  const geometry = calculateVoiceOverlayGeometry(snapshot, latestArea ?? screen.getPrimaryDisplay().workArea);
  if (!geometry || !geometry.shouldShow) {
    lockVoiceOverlay();
    hideActionWindow();
    hideNotificationActionWindow();
    hideChatActionWindow();
    setMouseIgnored(true);
    lifecycle.update({ ...snapshot, enabled: false }, {
      isDestroyed: () => !overlayWindow || overlayWindow.isDestroyed(),
      isLoading: () => false,
      onDidFinishLoad: () => undefined,
      hide: () => overlayWindow?.hide(),
      deliver: () => undefined,
    });
    return;
  }
  const win = ensureOverlay();
  const boundedSnapshot = { ...snapshot, voiceOverlayMaxParticipants: geometry.effectiveMaxParticipants };
  lifecycle.update(boundedSnapshot, {
    identity: win,
    isDestroyed: () => win.isDestroyed(),
    isLoading: () => win.webContents.isLoading(),
    onDidFinishLoad: (callback) => { win.webContents.once("did-finish-load", callback); },
    hide: () => win.hide(),
    deliver: () => {
      if (win.isDestroyed()) return;
      const currentGeometry = calculateVoiceOverlayGeometry(latest ?? boundedSnapshot, latestArea ?? screen.getPrimaryDisplay().workArea);
      if (!currentGeometry?.shouldShow) {
        hideActionWindow();
        hideChatActionWindow();
        setMouseIgnored(true);
        win.hide();
        return;
      }
      win.setSize(currentGeometry.width, currentGeometry.height, false);
      if (!unlocked) {
        const bounds = latestArea ?? screen.getPrimaryDisplay().workArea;
        const { x, y } = layoutPoint ? restoreOverlayPosition(layoutPoint, currentGeometry, bounds) : constrainOverlayPosition(currentGeometry, currentGeometry, bounds);
        win.setPosition(x, y, false);
      }
      // Paint the current privacy-scoped snapshot before re-showing a hidden window.
      win.webContents.send("voice-overlay-update", voiceOverlayPayload());
      win.showInactive();
      notifyMediaLifecycle();
      publishWelcomeAfterShow(win);
      publishGoLiveAfterShow(win);
      win.webContents.send("voice-overlay-update", voiceOverlayPayload());
      updateMousePolicy();
      updateNotificationActionWindow();
      updateChatActionWindow();
    },
  });
}

export function closeVoiceOverlay(): void {
  mediaDocumentUsable = false; notifyMediaLifecycle(true);
  lockVoiceOverlay();
  if (actionWindow && !actionWindow.isDestroyed()) actionWindow.close();
  actionWindow = null;
  actionLoadPending = false;
  if (notificationActionWindow && !notificationActionWindow.isDestroyed()) notificationActionWindow.close();
  notificationActionWindow = null;
  notificationActionLoadPending = false;
  if (chatActionWindow && !chatActionWindow.isDestroyed()) chatActionWindow.close();
  chatActionWindow = null;
  chatActionLoadPending = false;
  closeChatComposerWindow();
  pendingOpenInbox = null;
  pendingNotificationReply = null;
  pendingOpenChat = null;
  layoutPoint = null;
  lifecycle.close();
  clearWelcome();
  latest = null;
  if (gameNoticeTimer) clearTimeout(gameNoticeTimer);
  gameNoticeTimer = null;
  latestArea = null;
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  overlayWindow = null;
}
