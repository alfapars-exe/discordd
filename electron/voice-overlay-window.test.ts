import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { INBOX_ACTION_HEIGHT, INBOX_ACTION_WIDTH } from "./overlay-action-regions";
import type { VoiceOverlaySnapshot } from "./voice-overlay-contract";

test("native overlay lock toggles only visible widgets and bounds unlocked game movement", async () => {
  let win!: FakeWindow;
  let actionWin!: FakeWindow;
  let notificationActionWin!: FakeWindow;
  let chatActionWin!: FakeWindow;
  let chatComposerWin!: FakeWindow;
  let failShape = false;
  let suppressShow = false;
  let cursor = { x: 0, y: 0 };
  let now = 1000;
  const timers = new Set<() => void>();
  const timeouts = new Set<() => void>();
  const forwarded: Array<{ channel: string; value: unknown }> = [];
  class FakeWindow extends EventEmitter {
    visible = false; destroyed = false; ignored = true;
    x = 0; y = 0; width = 300; height = 420;
    sent: Array<{ welcome?: { id: number; expiresAt: number } | null; goLive?: { id: number; expiresAt: number } | null; unlocked?: boolean; layoutSaveFailed?: boolean; quickActionsUnavailable?: boolean; notificationActionsUnavailable?: boolean; activities?: Array<{ userId: string }>; notifications?: Array<{ id: string; category: string }>; voiceOverlayNotifications?: boolean; notificationActionSession?: string; notificationReplySession?: string; notificationReplyButtons?: Array<{ id: string; row: number }>; voiceOverlayChat?: boolean; voiceOverlayChatActions?: boolean; voiceOverlayChatCompose?: boolean; chatStatus?: string; chatMessages?: Array<{ id: string; author: string; text: string }>; chatActionSession?: string; chatComposeSession?: string; chatComposeLabel?: string; participants?: unknown[] }> = [];
    shape: Array<{ x: number; y: number; width: number; height: number }> = [];
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {},
      isLoading: () => false,
      send: (channel: string, value: { welcome?: { id: number; expiresAt: number } | null; goLive?: { id: number; expiresAt: number } | null; unlocked?: boolean; layoutSaveFailed?: boolean; quickActionsUnavailable?: boolean; notificationActionsUnavailable?: boolean; activities?: Array<{ userId: string }>; notifications?: Array<{ id: string; category: string }>; voiceOverlayNotifications?: boolean; notificationActionSession?: string; notificationReplySession?: string; notificationReplyButtons?: Array<{ id: string; row: number }>; voiceOverlayChat?: boolean; voiceOverlayChatActions?: boolean; voiceOverlayChatCompose?: boolean; chatStatus?: string; chatMessages?: Array<{ id: string; author: string; text: string }>; chatActionSession?: string; chatComposeSession?: string; chatComposeLabel?: string; participants?: unknown[] }) => { this.sent.push(value); if (channel === "overlay-chat-send" || channel === "overlay-chat-composer-closed") forwarded.push({ channel, value }); },
    });
    focusCount = 0;
    constructor(public options: Record<string, unknown>) { super(); if (options.width === 360 && options.height === 180) chatComposerWin = this; else if (options.width === 88 && options.height === 40) actionWin = this; else if (options.width !== 88 || options.height !== 20) win = this; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    setAlwaysOnTop() {}
    setShape(shape: typeof this.shape) { if (failShape) throw new Error("unavailable"); this.shape = shape; }
    setIgnoreMouseEvents(ignored: boolean) { this.ignored = ignored; }
    loadURL(url: string) { if (url.includes("surface=notification-actions")) notificationActionWin = this; if (url.includes("surface=chat-actions")) chatActionWin = this; if (url.includes("surface=chat-composer")) chatComposerWin = this; return Promise.resolve(); }
    hide() { this.visible = false; this.emit("hide"); }
    showInactive() { if (!suppressShow) this.visible = true; }
    show() { this.visible = true; }
    focus() { this.focusCount++; }
    setSize(width: number, height: number) { this.width = width; this.height = height; }
    setPosition(x: number, y: number) { this.x = x; this.y = y; }
    getPosition() { return [this.x, this.y]; }
    getBounds() { return { x: this.x, y: this.y, width: this.width, height: this.height }; }
    close() { this.destroyed = true; this.visible = false; this.emit("closed"); }
  }
  const requireActual = createRequire(__filename);
  const exports = {} as typeof import("./voice-overlay");
  const injectedRequire = (name: string) => name === "electron" ? {
    app: { isPackaged: false }, BrowserWindow: FakeWindow,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }), getCursorScreenPoint: () => cursor },
  } : requireActual(name);
  vm.runInNewContext(readFileSync(path.join(__dirname, "voice-overlay.js"), "utf8"), {
    exports, __dirname, process: { platform: "win32", env: { NODE_ENV: "test" } }, Date: { now: () => now },
    setInterval: (callback: () => void) => { timers.add(callback); return { callback, unref: () => {} }; },
    clearInterval: (timer: { callback: () => void }) => { timers.delete(timer.callback); },
    setTimeout: (callback: () => void) => { timeouts.add(callback); return { callback }; },
    clearTimeout: (timer: { callback: () => void }) => { timeouts.delete(timer.callback); },
    require: injectedRequire,
  });
  exports.toggleVoiceOverlayLock(); // No window: no-op.
  const stored = new Map<string, { x: number; y: number }>();
  let writeAllowed = true;
  exports.configureVoiceOverlayLayout({
    get: (context) => stored.get(context) ?? null,
    set: (context, point) => { if (!writeAllowed) return false; stored.set(context, point); return true; },
    remove: (context) => { if (!writeAllowed) return false; stored.delete(context); return true; },
    reset: () => { if (!writeAllowed) return false; stored.clear(); return true; },
  });
  const snapshot: VoiceOverlaySnapshot = { enabled: true, voiceOverlayMode: "game", participants: [{ id: "one", name: "One", avatarUrl: "", speaking: true, muted: false, deafened: false }], speakingOpacity: 100, idleOpacity: 35, scale: 100, position: "top-left", speakingOnly: false, voiceOverlayAvatarSize: "small", voiceOverlayNameDisplay: "always", voiceOverlayMaxParticipants: 25 };
  const area = { x: -1000, y: 0, width: 900, height: 700 };
  const context = "game:12345678-1234-1234-1234-123456789abc";
  exports.updateVoiceOverlay(snapshot, area, context);
  assert.equal(win.options.focusable, false);
  assert.equal(win.ignored, true);
  exports.toggleVoiceOverlayLock();
  assert.equal(win.ignored, false);
  assert.equal(win.sent[win.sent.length - 1].unlocked, true);
  let prevented = false;
  win.emit("will-move", { preventDefault() { prevented = true; } }, { x: 2000, y: -300, width: win.width, height: win.height });
  assert.equal(prevented, true);
  assert.ok(win.x >= area.x && win.x + win.width <= area.x + area.width);
  assert.equal(win.y, area.y);
  exports.toggleVoiceOverlayLock();
  assert.ok(stored.has(context), "locking persists normalized placement for the exact game ID");
  const saved = stored.get(context)!;
  assert.ok(saved.x >= 0 && saved.x <= 1 && saved.y >= 0 && saved.y <= 1);
  exports.updateVoiceOverlay({ ...snapshot, voiceOverlayPinned: true }, area);
  exports.toggleVoiceOverlayLock();
  assert.equal(win.ignored, true, "pin blocks global movement unlock");
  exports.updateVoiceOverlay(snapshot, area);
  exports.toggleVoiceOverlayLock();
  writeAllowed = false;
  exports.toggleVoiceOverlayLock();
  assert.equal(win.sent[win.sent.length - 1].layoutSaveFailed, true);
  exports.toggleVoiceOverlayLock();
  exports.updateVoiceOverlay(snapshot, area, "game:11111111-1234-1234-1234-123456789abc");
  assert.equal(win.sent[win.sent.length - 1].layoutSaveFailed, true, "changing games cannot silently erase a failed position save");
  const beforeReset = { x: win.x, y: win.y };
  assert.equal(exports.resetVoiceOverlayLayout(), false);
  assert.deepEqual({ x: win.x, y: win.y }, beforeReset);
  writeAllowed = true;
  assert.equal(exports.resetVoiceOverlayLayout(), true);
  assert.equal(stored.size, 0);
  assert.equal(win.ignored, true);
  exports.updateVoiceOverlay(snapshot, area);
  exports.toggleVoiceOverlayLock();
  exports.updateVoiceOverlay(snapshot, { ...area, x: -900 });
  assert.equal(win.ignored, true); // Moving the game re-locks the widget.
  exports.toggleVoiceOverlayLock();
  exports.updateVoiceOverlay({ ...snapshot, enabled: false }, area);
  assert.equal(win.visible, false);
  assert.equal(win.ignored, true);
  exports.toggleVoiceOverlayLock();
  assert.equal(win.ignored, true); // Hidden widgets cannot be unlocked.
  exports.closeVoiceOverlay();
  stored.set(context, { x: 0.75, y: 0.25 });
  exports.updateVoiceOverlay(snapshot, area, context);
  const restored = requireActual("./voice-overlay-geometry").restoreOverlayPosition({ x: 0.75, y: 0.25 }, { width: win.width, height: win.height }, area);
  assert.deepEqual({ x: win.x, y: win.y }, restored, "recreated windows restore the persisted exact-game placement");
  exports.updateVoiceOverlay(snapshot, area, "game:87654321-1234-1234-1234-123456789abc");
  assert.notDeepEqual({ x: win.x, y: win.y }, restored, "a different game cannot inherit the old game's custom offset");
  const actionable = { ...snapshot, voiceOverlayQuickActions: true, voiceOverlayClickableActions: true, voiceActionSession: "session-a" };
  exports.updateVoiceOverlay(actionable, area);
  assert.equal(actionWin.visible, true);
  assert.equal(actionWin.options.focusable, false);
  assert.equal(JSON.stringify(actionWin.shape), JSON.stringify([{ x: 0, y: 0, width: 40, height: 40 }, { x: 48, y: 0, width: 40, height: 40 }]));
  cursor = { x: win.x + win.width - 90, y: win.y + win.height - 40 };
  for (const tick of timers) tick();
  assert.equal(win.ignored, true, "the voice window always passes locked clicks through; the shaped toolbar owns its exact buttons");
  const sender = { sender: actionWin.webContents, senderFrame: actionWin.webContents.mainFrame };
  assert.equal(exports.takeVoiceOverlayAction({ ...sender, senderFrame: {} }, "toggle-mute", "session-a"), null);
  assert.equal(exports.takeVoiceOverlayAction(sender, "toggle-deafen", "session-a"), null, "action must match the actual cursor target");
  assert.equal(exports.takeVoiceOverlayAction(sender, "toggle-mute", "stale-session"), null);
  assert.equal(exports.takeVoiceOverlayAction(sender, "toggle-mute", "session-a")?.action, "toggle-mute");
  assert.equal(exports.takeVoiceOverlayAction(sender, "toggle-mute", "session-a"), null, "duplicate clicks are rate bounded");
  now += 500;
  cursor = { x: win.x + win.width - 52, y: cursor.y };
  for (const tick of timers) tick();
  assert.equal(win.ignored, true, "the eight-DIP gap passes clicks through");
  assert.equal(exports.takeVoiceOverlayAction(sender, "toggle-mute", "session-a"), null);
  exports.updateVoiceOverlay({ ...actionable, voiceOverlayClickableActions: false }, area);
  assert.equal(timers.size, 0);
  assert.equal(actionWin.visible, false);
  assert.equal(win.ignored, true);
  assert.equal(exports.takeVoiceOverlayAction(sender, "toggle-mute", "session-a"), null);
  exports.updateVoiceOverlay({ ...actionable, voiceActionSession: "session-b" }, area);
  assert.equal(exports.takeVoiceOverlayAction(sender, "toggle-mute", "session-a"), null);
  exports.closeVoiceOverlay();
  assert.equal(timers.size, 0);
  failShape = true;
  exports.updateVoiceOverlay(actionable, area);
  assert.equal(actionWin.destroyed, true);
  assert.equal(win.sent[win.sent.length - 1].quickActionsUnavailable, true);
  assert.equal(win.ignored, true);
  exports.updateVoiceOverlay({ ...actionable, voiceOverlayQuickActions: false }, area);
  failShape = false;
  exports.updateVoiceOverlay(actionable, area);
  assert.equal(actionWin.visible, true, "explicit feature retry can recover native shape creation");
  exports.closeVoiceOverlay();
  const notificationsOnly = { ...snapshot, participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayNotifications: true,
    notificationStatus: "ready" as const,
    notifications: (["mention", "reply", "friend_request"] as const).map((category, index) => ({ id: `notification-${index}`, category })),
    voiceOverlayChat: true, chatStatus: "ready" as const,
    chatMessages: [{ id: "chat-message-private", author: "Ada", text: "private chat text" }],
    voiceOverlayChatActions: true, chatActionSession: "session-chat" };
  const notificationActions = { ...notificationsOnly, voiceOverlayClickableActions: false, voiceOverlayNotificationActions: true, notificationActionSession: "session-notifications" };
  exports.updateVoiceOverlay(notificationActions, area);
  assert.equal(win.visible, true, "the read-only notification panel can show independently of a voice roster");
  assert.equal(win.sent[win.sent.length - 1].notifications?.length, 3, "delivery stays capped at three indicators");
  assert.equal(notificationActionWin.visible, true);
  assert.equal(notificationActionWin.options.focusable, false);
  assert.equal(JSON.stringify(notificationActionWin.shape), JSON.stringify([{ x: 0, y: 0, width: INBOX_ACTION_WIDTH, height: INBOX_ACTION_HEIGHT }]));
  assert.equal(notificationActionWin.sent[notificationActionWin.sent.length - 1].notifications, undefined, "the interactive action surface never receives notification data");
  assert.equal(notificationActionWin.sent[notificationActionWin.sent.length - 1].notificationActionSession, "session-notifications");
  assert.equal(notificationActionWin.sent[notificationActionWin.sent.length - 1].chatActionSession, undefined, "the inbox child never receives a chat action session");
  assert.equal(chatActionWin.visible, true, "the chat action surface can coexist with the notification widget");
  assert.equal(chatActionWin.options.focusable, false);
  assert.equal(JSON.stringify(chatActionWin.shape), JSON.stringify([{ x: 0, y: 0, width: 88, height: 20 }]));
  assert.equal(chatActionWin.sent[chatActionWin.sent.length - 1].chatActionSession, "session-chat");
  assert.equal(chatActionWin.sent[chatActionWin.sent.length - 1].chatMessages?.length, 0, "the chat action child receives no plaintext or message identifiers");
  assert.equal(chatActionWin.sent[chatActionWin.sent.length - 1].notificationActionSession, undefined, "the chat child never receives a notification session");
  const notificationSender = { sender: notificationActionWin.webContents, senderFrame: notificationActionWin.webContents.mainFrame };
  let restores = 0, shows = 0, focuses = 0;
  const mainFrame = {};
  const mainWebContents = { mainFrame, send: (channel: string, value: unknown) => { if (channel === "overlay-chat-send" || channel === "overlay-chat-composer-closed") forwarded.push({ channel, value }); } };
  const mainWindow = {
    webContents: mainWebContents, isDestroyed: () => false, isMinimized: () => true,
    restore: () => { restores++; }, show: () => { shows++; }, focus: () => { focuses++; },
  };
  const chatSender = { sender: chatActionWin.webContents, senderFrame: chatActionWin.webContents.mainFrame };
  const chatBounds = chatActionWin.getBounds();
  assert.equal(chatBounds.x, win.x + win.width - 8 - 88, "chat button is aligned to the panel header's right inset");
  assert.equal(chatBounds.y, win.y + 8, "chat button stays in the chat header above the lower widgets");
  cursor = { x: chatBounds.x + 88, y: chatBounds.y + 10 };
  assert.equal(exports.takeVoiceOverlayOpenChatIntent(chatSender, "session-chat"), null, "the hit region excludes the right boundary");
  cursor = { x: chatBounds.x + 10, y: chatBounds.y + 10 };
  assert.equal(exports.takeVoiceOverlayOpenChatIntent({ ...chatSender, senderFrame: {} }, "session-chat"), null);
  assert.equal(exports.takeVoiceOverlayOpenChatIntent(notificationSender, "session-chat"), null, "the inbox surface cannot invoke a chat open");
  assert.equal(exports.takeVoiceOverlayOpenChatIntent(chatSender, "stale-session"), null);
  assert.equal(exports.takeVoiceOverlayOpenChatIntent(chatSender, "session-chat")?.session, "session-chat");
  assert.equal(exports.confirmVoiceOverlayOpenChat(chatSender, "session-chat", mainWindow), false, "the child surface cannot confirm or focus the main window");
  assert.equal(exports.confirmVoiceOverlayOpenChat({ sender: {}, senderFrame: {} }, "session-chat", mainWindow), false, "untrusted main frames cannot confirm");
  assert.equal(exports.confirmVoiceOverlayOpenChat({ sender: mainWebContents, senderFrame: mainFrame }, "session-chat", mainWindow), true);
  assert.deepEqual([restores, shows, focuses], [1, 1, 1], "trusted chat confirmation restores and focuses exactly once");
  win.hide();
  assert.equal(chatActionWin.visible, false, "hiding the owner hides the chat hit surface");
  assert.equal(chatActionWin.sent[chatActionWin.sent.length - 1].chatActionSession, undefined, "owner visibility loss clears the child session");
  exports.updateVoiceOverlay(notificationActions, area);
  assert.equal(chatActionWin.visible, true, "a fresh visible owner snapshot restores the action surface");
  assert.equal(chatActionWin.sent[chatActionWin.sent.length - 1].chatActionSession, "session-chat");
  assert.equal(exports.confirmVoiceOverlayOpenChat({ sender: mainWebContents, senderFrame: mainFrame }, "session-chat", mainWindow), false, "chat confirmation is one-shot");
  now += 251;
  assert.ok(exports.takeVoiceOverlayOpenChatIntent(chatSender, "session-chat"));
  now += 5001;
  assert.equal(exports.confirmVoiceOverlayOpenChat({ sender: mainWebContents, senderFrame: mainFrame }, "session-chat", mainWindow), false, "expired chat intents cannot focus");
  now += 251;
  assert.ok(exports.takeVoiceOverlayOpenChatIntent(chatSender, "session-chat"));
  exports.updateVoiceOverlay({ ...notificationActions, chatActionSession: "next-chat-session" }, area);
  assert.equal(exports.confirmVoiceOverlayOpenChat({ sender: mainWebContents, senderFrame: mainFrame }, "session-chat", mainWindow), false, "rotating chat scope invalidates a pending open");
  now += 251;
  const composeSnapshot = { ...notificationActions, chatActionSession: "chat-open-2", voiceOverlayChatCompose: true,
    chatComposeSession: "compose-session-1", chatComposeLabel: "general" };
  exports.updateVoiceOverlay(composeSnapshot, area);
  assert.equal(chatActionWin.width, 184);
  assert.equal(JSON.stringify(chatActionWin.shape), JSON.stringify([{ x: 0, y: 0, width: 88, height: 20 }, { x: 96, y: 0, width: 88, height: 20 }]));
  const composerActionBounds = chatActionWin.getBounds();
  assert.equal(composerActionBounds.x, win.x + win.width - 8 - 184);
  cursor = { x: composerActionBounds.x + 88, y: composerActionBounds.y + 10 };
  assert.equal(exports.takeVoiceOverlayOpenChatComposerIntent(chatSender, "compose-session-1", mainWindow), null, "the gap between shaped buttons cannot open a composer");
  cursor = { x: composerActionBounds.x + 8, y: composerActionBounds.y + 10 };
  assert.equal(exports.takeVoiceOverlayOpenChatComposerIntent(notificationSender, "compose-session-1", mainWindow), null, "other child surfaces cannot open a composer");
  assert.equal(exports.takeVoiceOverlayOpenChatComposerIntent(chatSender, "stale-compose", mainWindow), null);
  assert.equal(exports.takeVoiceOverlayOpenChatComposerIntent(chatSender, "compose-session-1", mainWindow)?.session, "compose-session-1");
  assert.equal(chatComposerWin.visible, true);
  assert.equal(chatComposerWin.options.focusable, true);
  assert.equal(chatComposerWin.focusCount, 1);
  assert.equal(chatComposerWin.options.width, 360);
  assert.equal(chatComposerWin.options.height, 280);
  const composerPayload = chatComposerWin.sent[chatComposerWin.sent.length - 1];
  assert.equal(composerPayload.chatComposeSession, "compose-session-1");
  assert.equal(composerPayload.chatComposeLabel, "general");
  assert.equal(composerPayload.chatMessages, undefined, "composer receives no plaintext history or message identifiers");
  assert.equal(composerPayload.chatActionSession, undefined);
  assert.equal(chatActionWin.sent[chatActionWin.sent.length - 1].chatComposeLabel, undefined, "the hit surface never receives the current channel label");
  const focusCountAfterOpen = chatComposerWin.focusCount;
  exports.updateVoiceOverlay({ ...composeSnapshot, chatComposeLabel: "renamed-channel" }, area);
  assert.equal(chatComposerWin.sent[chatComposerWin.sent.length - 1].chatComposeLabel, "renamed-channel", "same-grant updates refresh a renamed channel label");
  assert.equal(chatComposerWin.focusCount, focusCountAfterOpen, "background label refresh does not steal focus");
  assert.equal(await exports.sendOverlayChatMessage(notificationSender, { session: "compose-session-1", requestId: "wrong-child", text: "hello" }, mainWindow), "unavailable");
  const composerSender = { sender: chatComposerWin.webContents, senderFrame: chatComposerWin.webContents.mainFrame };
  assert.equal(await exports.sendOverlayChatMessage(composerSender, { session: "compose-session-1", requestId: "bad-text", text: "bad\u0001text" }, mainWindow), "failed");
  assert.equal(await exports.sendOverlayChatMessage(composerSender, { session: "compose-session-1", requestId: "too-long", text: "x".repeat(2001) }, mainWindow), "failed");
  const delivered = exports.sendOverlayChatMessage(composerSender, { session: "compose-session-1", requestId: "request-1", text: "hello there" }, mainWindow);
  assert.equal(JSON.stringify(forwarded[forwarded.length - 1]), JSON.stringify({ channel: "overlay-chat-send", value: { session: "compose-session-1", requestId: "request-1", text: "hello there" } }));
  assert.equal(await exports.sendOverlayChatMessage(composerSender, { session: "compose-session-1", requestId: "request-2", text: "another" }, mainWindow), "unavailable", "only one send can be in flight");
  assert.equal(exports.resolveOverlayChatSend(chatSender, { session: "compose-session-1", requestId: "request-1", result: "sent" }, mainWindow), false, "action children cannot resolve sends");
  assert.equal(exports.resolveOverlayChatSend({ sender: mainWebContents, senderFrame: {} }, { session: "compose-session-1", requestId: "request-1", result: "sent" }, mainWindow), false, "subframes cannot resolve sends");
  const mainSender = { sender: mainWebContents, senderFrame: mainFrame };
  assert.equal(exports.resolveOverlayChatSend(mainSender, { session: "compose-session-1", requestId: "wrong-request", result: "sent" }, mainWindow), false);
  assert.equal(exports.resolveOverlayChatSend(mainSender, { session: "compose-session-1", requestId: "request-1", result: "sent" }, mainWindow), true);
  assert.equal(await delivered, "sent");
  assert.equal(exports.resolveOverlayChatSend(mainSender, { session: "compose-session-1", requestId: "request-1", result: "sent" }, mainWindow), false, "terminal completion is one-shot");
  assert.equal(await exports.sendOverlayChatMessage(composerSender, { session: "compose-session-1", requestId: "request-1", text: "replay" }, mainWindow), "unavailable", "completed request IDs cannot replay within a compose grant");
  const timedOut = exports.sendOverlayChatMessage(composerSender, { session: "compose-session-1", requestId: "request-timeout", text: "wait" }, mainWindow);
  const timeout = [...timeouts][0];
  assert.ok(timeout);
  timeout();
  assert.equal(await timedOut, "failed", "a bounded missing renderer response fails conservatively");
  assert.equal(await exports.sendOverlayChatMessage(composerSender, { session: "compose-session-1", requestId: "request-timeout", text: "no retry" }, mainWindow), "unavailable");
  assert.equal(exports.closeOverlayChatComposer(chatSender, "compose-session-1"), false, "the action surface cannot close the composer");
  assert.equal(exports.closeOverlayChatComposer(composerSender, "compose-session-1"), true);
  assert.equal(JSON.stringify(forwarded[forwarded.length - 1]), JSON.stringify({ channel: "overlay-chat-composer-closed", value: { session: "compose-session-1" } }));
  assert.equal(chatComposerWin.visible, false);
  assert.equal(await exports.sendOverlayChatMessage(composerSender, { session: "compose-session-1", requestId: "after-close", text: "no" }, mainWindow), "unavailable");
  assert.equal(exports.takeVoiceOverlayOpenChatComposerIntent(chatSender, "compose-session-1", mainWindow), null, "a closed composer grant cannot reopen or reset its replay ledger");
  const renewedCompose = { ...composeSnapshot, chatComposeSession: "compose-session-2" };
  exports.updateVoiceOverlay(renewedCompose, area);
  now += 251;
  assert.ok(exports.takeVoiceOverlayOpenChatComposerIntent(chatSender, "compose-session-2", mainWindow));
  const composerSenderAfterReopen = { sender: chatComposerWin.webContents, senderFrame: chatComposerWin.webContents.mainFrame };
  const otherMainWindow = { ...mainWindow, webContents: { mainFrame: {}, send: (_channel: string, _value: unknown) => {} } };
  assert.equal(await exports.sendOverlayChatMessage(composerSenderAfterReopen, { session: "compose-session-2", requestId: "wrong-owner", text: "no" }, otherMainWindow), "unavailable", "a different main-window instance cannot receive composer plaintext");
  for (let index = 0; index < 64; index++) {
    const requestId = `cap-${index}`;
    const pending = exports.sendOverlayChatMessage(composerSenderAfterReopen, { session: "compose-session-2", requestId, text: "bounded message" }, mainWindow);
    assert.equal(exports.resolveOverlayChatSend(mainSender, { session: "compose-session-2", requestId, result: "sent" }, mainWindow), true);
    assert.equal(await pending, "sent");
  }
  assert.equal(await exports.sendOverlayChatMessage(composerSenderAfterReopen, { session: "compose-session-2", requestId: "cap-overflow", text: "no" }, mainWindow), "unavailable", "request ledger is bounded and refuses IDs beyond its cap");
  const reloadPending = exports.sendOverlayChatMessage(composerSenderAfterReopen, { session: "compose-session-2", requestId: "reload-pending", text: "clear on reload" }, mainWindow);
  chatComposerWin.webContents.emit("did-start-navigation", {}, "app://hichat/overlay.html?surface=chat-composer", false, true);
  assert.equal(await reloadPending, "unavailable", "a child reload cancels its in-flight request");
  assert.equal(chatComposerWin.destroyed, true, "a full-frame composer reload destroys the old draft/session window");
  assert.equal(exports.takeVoiceOverlayOpenChatComposerIntent(chatSender, "compose-session-2", mainWindow), null, "a reloaded child cannot reuse the prior compose grant");
  const rotatedCompose = { ...renewedCompose, chatComposeSession: "compose-session-3" };
  exports.updateVoiceOverlay(rotatedCompose, area);
  now += 251;
  assert.ok(exports.takeVoiceOverlayOpenChatComposerIntent(chatSender, "compose-session-3", mainWindow));
  const composerSenderAfterRotation = { sender: chatComposerWin.webContents, senderFrame: chatComposerWin.webContents.mainFrame };
  const revokedPending = exports.sendOverlayChatMessage(composerSenderAfterRotation, { session: "compose-session-3", requestId: "request-revoke", text: "cancel" }, mainWindow);
  exports.updateVoiceOverlay({ ...rotatedCompose, voiceOverlayChatCompose: false, chatComposeSession: undefined, chatComposeLabel: undefined }, area);
  assert.equal(await revokedPending, "unavailable", "grant revocation cancels an in-flight send");
  assert.equal(chatComposerWin.visible, false, "grant revocation destroys the focused child and its draft");
  exports.updateVoiceOverlay({ ...notificationActions, voiceOverlayChatActions: false }, area);
  assert.equal(chatActionWin.visible, false, "revoking chat-action consent hides its hit surface");
  assert.equal(exports.takeVoiceOverlayOpenChatIntent(chatSender, "session-chat"), null);
  exports.updateVoiceOverlay({ ...notificationActions, voiceOverlayChatActions: false, voiceOverlayQuickActions: true,
    voiceOverlayClickableActions: true, voiceActionSession: "voice-session" }, area);
  assert.equal(actionWin.sent[actionWin.sent.length - 1].chatActionSession, undefined, "the voice-action child never receives the chat session");
  assert.equal(actionWin.sent[actionWin.sent.length - 1].chatMessages, undefined, "the voice-action child never receives chat text");
  const notificationBounds = notificationActionWin.getBounds();
  cursor = { x: notificationBounds.x + 20, y: notificationBounds.y + 10 };
  assert.equal(exports.takeVoiceOverlayOpenInboxIntent({ ...notificationSender, senderFrame: {} }, "session-notifications"), null);
  assert.equal(exports.takeVoiceOverlayOpenInboxIntent(notificationSender, "stale-session"), null);
  assert.equal(exports.takeVoiceOverlayOpenInboxIntent(notificationSender, "session-notifications")?.session, "session-notifications");
  assert.equal(exports.confirmVoiceOverlayOpenInbox({ sender: {}, senderFrame: {} }, "session-notifications", mainWindow), false, "untrusted main frames cannot confirm or focus");
  assert.equal(exports.confirmVoiceOverlayOpenInbox({ sender: mainWebContents, senderFrame: mainFrame }, "session-notifications", mainWindow), true);
  assert.deepEqual([restores, shows, focuses], [2, 2, 2], "each trusted action restores and focuses exactly once");
  assert.equal(exports.confirmVoiceOverlayOpenInbox({ sender: mainWebContents, senderFrame: mainFrame }, "session-notifications", mainWindow), false, "confirmation is one-shot");
  now += 251;
  assert.ok(exports.takeVoiceOverlayOpenInboxIntent(notificationSender, "session-notifications"));
  now += 5001;
  assert.equal(exports.confirmVoiceOverlayOpenInbox({ sender: mainWebContents, senderFrame: mainFrame }, "session-notifications", mainWindow), false, "expired clicks cannot focus");
  now += 251;
  const nextIntent = exports.takeVoiceOverlayOpenInboxIntent(notificationSender, "session-notifications");
  assert.ok(nextIntent);
  exports.updateVoiceOverlay({ ...notificationActions, notificationActionSession: "next-session" }, area);
  assert.equal(exports.confirmVoiceOverlayOpenInbox({ sender: mainWebContents, senderFrame: mainFrame }, "session-notifications", mainWindow), false, "rotating auth scope invalidates pending opens");
  assert.equal(notificationActionWin.sent[notificationActionWin.sent.length - 1].notifications, undefined);
  exports.updateVoiceOverlay({ ...notificationActions, voiceOverlayNotificationActions: false }, area);
  assert.equal(notificationActionWin.visible, false, "revoking action consent hides the separate hit surface");
  exports.closeVoiceOverlay();
  failShape = true;
  exports.updateVoiceOverlay(notificationActions, area);
  assert.equal(notificationActionWin.destroyed, true, "shape failure disables the independent action surface");
  assert.equal(win.sent[win.sent.length - 1].notificationActionsUnavailable, true, "the passive panel reports the failed native shape");
  failShape = false;
  exports.updateVoiceOverlay({ ...notificationActions, voiceOverlayNotificationActions: false }, area);
  exports.updateVoiceOverlay(notificationActions, area);
  assert.equal(notificationActionWin.visible, true, "explicit opt-out and re-opt-in can retry native shape creation");
  exports.closeVoiceOverlay();
  const activityOnly = { ...snapshot, participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayActivity: true,
    activities: Array.from({ length: 5 }, (_, i) => ({ userId: `friend-${i}`, label: "Friend", gameName: "Game" })) };
  exports.updateVoiceOverlay(activityOnly, { ...area, height: 220 });
  assert.equal(win.visible, true, "an activity panel is independent of the voice roster");
  const visibleCards = win.sent[win.sent.length - 1].activities!.length;
  assert.ok(visibleCards > 0 && visibleCards < 5);
  exports.toggleVoiceOverlayLock();
  assert.equal(win.sent[win.sent.length - 1].activities!.length, visibleCards, "unlock delivery preserves physical row limits");
  exports.lockVoiceOverlay();
  assert.equal(win.sent[win.sent.length - 1].activities!.length, visibleCards);
  exports.closeVoiceOverlay();
  const welcomeSnapshot = { ...snapshot, voiceOverlayWelcome: true };
  suppressShow = true;
  exports.updateVoiceOverlay(welcomeSnapshot, area, context);
  assert.equal(win.sent[win.sent.length - 1]?.welcome, null, "attempted but invisible native show cannot invent a welcome");
  suppressShow = false;
  exports.updateVoiceOverlay(welcomeSnapshot, area, context);
  const firstWelcome = win.sent[win.sent.length - 1]!.welcome!;
  assert.ok(firstWelcome && firstWelcome.expiresAt === now + 5000);
  exports.updateVoiceOverlay(welcomeSnapshot, area, context);
  assert.equal(win.sent[win.sent.length - 1]!.welcome!.id, firstWelcome.id, "routine snapshots do not replay welcome");
  now += 5001;
  for (const timeout of Array.from(timeouts)) timeout();
  assert.equal(win.sent[win.sent.length - 1]!.welcome, null, "expiry updates the same native window");
  exports.updateVoiceOverlay(welcomeSnapshot, area, context);
  assert.equal(win.sent[win.sent.length - 1]!.welcome, null, "expired welcome remains consumed for this activation");
  exports.updateVoiceOverlay({ ...welcomeSnapshot, enabled: false }, area, context);
  assert.equal(win.visible, false);
  exports.updateVoiceOverlay(welcomeSnapshot, area, context);
  assert.ok(win.sent[win.sent.length - 1]!.welcome!.id > firstWelcome.id, "real hidden-to-shown activation gets one fresh welcome");
  const priorContextNotice = win.sent[win.sent.length - 1]!.welcome!.id;
  exports.updateVoiceOverlay(welcomeSnapshot, area, "game:87654321-1234-1234-1234-123456789abc");
  assert.ok(win.sent[win.sent.length - 1]!.welcome!.id > priorContextNotice, "new authorized game context gets a separate activation");
  exports.updateVoiceOverlay({ ...welcomeSnapshot, voiceOverlayWelcome: false }, area);
  assert.equal(win.sent[win.sent.length - 1]!.welcome, null);
  exports.updateVoiceOverlay(welcomeSnapshot, area);
  assert.equal(win.sent[win.sent.length - 1]!.welcome, null, "turning on a preference in an already visible overlay is not a show");
  exports.closeVoiceOverlay();
  const goLiveSnapshot = { ...snapshot, voiceOverlayGoLive: true, goLiveEligible: false };
  exports.updateVoiceOverlay(goLiveSnapshot, area, context);
  assert.equal(win.sent[win.sent.length - 1].goLive, null, "unready room cannot advertise sharing");
  exports.updateVoiceOverlay({ ...goLiveSnapshot, goLiveEligible: true }, area, context);
  assert.equal(win.sent[win.sent.length - 1].goLive, null, "late readiness is not another real overlay activation");
  exports.updateVoiceOverlay({ ...goLiveSnapshot, enabled: false }, area, context);
  const readyGoLive = { ...goLiveSnapshot, goLiveEligible: true, goLiveSession: "room-a" };
  exports.updateVoiceOverlay(readyGoLive, area, context);
  const firstGoLive = win.sent[win.sent.length - 1].goLive!;
  assert.ok(firstGoLive && firstGoLive.expiresAt === now + 5000);
  exports.updateVoiceOverlay(readyGoLive, area, context);
  assert.equal(win.sent[win.sent.length - 1].goLive!.id, firstGoLive.id);
  exports.updateVoiceOverlay({ ...readyGoLive, goLiveSession: "replacement-room" }, area, context);
  assert.equal(win.sent[win.sent.length - 1].goLive, null, "a room replacement cannot inherit the previous activation guide");
  exports.updateVoiceOverlay(goLiveSnapshot, area, context);
  assert.equal(win.sent[win.sent.length - 1].goLive, null, "losing readiness dismisses the active guide immediately");
  exports.updateVoiceOverlay(readyGoLive, area, context);
  assert.equal(win.sent[win.sent.length - 1].goLive, null, "regaining readiness never replays the same activation");
  exports.updateVoiceOverlay({ ...readyGoLive, enabled: false }, area, context);
  exports.updateVoiceOverlay(readyGoLive, area, context);
  assert.ok(win.sent[win.sent.length - 1].goLive!.id > firstGoLive.id);
  now += 5001;
  for (const timeout of Array.from(timeouts)) timeout();
  assert.equal(win.sent[win.sent.length - 1].goLive, null, "guide expires without starting a stream");
  exports.closeVoiceOverlay();
  exports.updateVoiceOverlay({ ...readyGoLive, voiceOverlayMode: "desktop" }, area, "desktop");
  assert.equal(win.sent[win.sent.length - 1].goLive, null, "desktop-only overlay does not claim a detected game");
  exports.closeVoiceOverlay();
  const replySnapshot = { ...notificationActions, notificationReplySession: "reply-session", notificationReplyIds: ["notification-0", "notification-1"] };
  exports.updateVoiceOverlay(replySnapshot, area);
  const replySender = { sender: notificationActionWin.webContents, senderFrame: notificationActionWin.webContents.mainFrame };
  const replyRequest = { session: "reply-session", notificationId: "notification-0" };
  const replyBounds = notificationActionWin.getBounds(); cursor = { x: replyBounds.x + 5, y: replyBounds.y + 31 };
  assert.equal(notificationActionWin.shape.length, 3, "the existing action window shapes only header and two allowed row targets");
  assert.equal(notificationActionWin.sent[notificationActionWin.sent.length - 1].notifications, undefined, "reply action receives no notification body/category payload");
  assert.equal(notificationActionWin.sent[notificationActionWin.sent.length - 1].notificationReplyButtons?.[0].id, "notification-0");
  assert.equal(exports.takeVoiceOverlayNotificationReplyIntent({ ...replySender, senderFrame: {} }, replyRequest), null);
  assert.equal(exports.takeVoiceOverlayNotificationReplyIntent(replySender, { ...replyRequest, url: "https://example.invalid" }), null);
  assert.equal(exports.takeVoiceOverlayNotificationReplyIntent(replySender, { ...replyRequest, notificationId: "notification-1" }), null, "a row cannot impersonate another visible row");
  now += 251;
  assert.ok(exports.takeVoiceOverlayNotificationReplyIntent(replySender, replyRequest));
  assert.equal(exports.confirmVoiceOverlayNotificationReply({ sender: {}, senderFrame: {} }, replyRequest, mainWindow), false);
  assert.equal(exports.confirmVoiceOverlayNotificationReply({ sender: mainWebContents, senderFrame: mainFrame }, replyRequest, mainWindow), true);
  assert.equal(exports.confirmVoiceOverlayNotificationReply({ sender: mainWebContents, senderFrame: mainFrame }, replyRequest, mainWindow), false, "reply focus consumes a one-shot physical intent");
  now += 251; assert.ok(exports.takeVoiceOverlayNotificationReplyIntent(replySender, replyRequest));
  now += 5001;
  assert.equal(exports.confirmVoiceOverlayNotificationReply({ sender: mainWebContents, senderFrame: mainFrame }, replyRequest, mainWindow), false, "expired physical reply intent cannot focus");
  now += 251; assert.ok(exports.takeVoiceOverlayNotificationReplyIntent(replySender, replyRequest));
  exports.updateVoiceOverlay({ ...replySnapshot, notificationReplySession: "replacement-session" }, area);
  assert.equal(exports.confirmVoiceOverlayNotificationReply({ sender: mainWebContents, senderFrame: mainFrame }, replyRequest, mainWindow), false, "rotated account/source session invalidates pending reply");
  exports.updateVoiceOverlay(replySnapshot, { ...area, height: 140 });
  const shortBounds = notificationActionWin.getBounds(); cursor = { x: shortBounds.x + 5, y: shortBounds.y + 63 };
  now += 251;
  assert.equal(exports.takeVoiceOverlayNotificationReplyIntent(replySender, { ...replyRequest, notificationId: "notification-1" }), null, "physically clipped rows cannot be invoked");
  exports.updateVoiceOverlay(replySnapshot, area);
  const renewedBounds = notificationActionWin.getBounds(); cursor = { x: renewedBounds.x + 5, y: renewedBounds.y + 31 };
  now += 251; assert.ok(exports.takeVoiceOverlayNotificationReplyIntent(replySender, replyRequest));
  notificationActionWin.close();
  exports.updateVoiceOverlay(replySnapshot, area);
  assert.equal(exports.confirmVoiceOverlayNotificationReply({ sender: mainWebContents, senderFrame: mainFrame }, replyRequest, mainWindow), false, "destroying the action surface prevents an old click from focusing through a replacement");
  exports.closeVoiceOverlay();
});
