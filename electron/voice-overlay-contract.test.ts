import assert from "node:assert/strict";
import test from "node:test";
import {
  parseVoiceOverlaySnapshot,
  visibleOverlayGameActivityNotices,
  applyAcknowledgedVoiceOverlaySnapshot,
  isTrustedVoiceOverlaySender,
  VoiceOverlayLifecycle,
  type VoiceOverlayLifecycleTarget,
  type VoiceOverlaySnapshot,
} from "./voice-overlay-contract";

const participant = {
  id: "user-123",
  name: "Ada",
  avatarUrl: "/api/uploads/avatars/ada.png",
  speaking: true,
  muted: false,
  deafened: false,
};

test("pin is optional for legacy renderers but strictly boolean when provided", () => {
  assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), voiceOverlayPinned: true })?.voiceOverlayPinned, true);
  assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), voiceOverlayPinned: "true" }), null);
  assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), voiceOverlayPinned: 1 }), null);
});
test("quick actions accept only bounded session and boolean device options", () => {
  assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), voiceOverlayQuickActions: true, voiceOverlayClickableActions: false, voiceActionSession: "session-a", selfMuted: false, selfDeafened: true })?.voiceActionSession, "session-a");
  for (const patch of [{ voiceOverlayQuickActions: 1 }, { voiceOverlayClickableActions: "true" }, { selfMuted: null }, { selfDeafened: 0 }, { voiceActionSession: "x".repeat(257) }, { voiceActionSession: "bad\nvalue" }]) assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), ...patch }), null);
});
test("activity IPC validates bounded unique cards and projects only display fields", () => {
  const activity = { userId: "friend", label: "Friend", gameName: "Game", executablePath: "not-forwarded" };
  const parsed = parseVoiceOverlaySnapshot({ ...validSnapshot(), voiceOverlayActivity: true, activities: [activity] });
  assert.deepEqual(parsed?.activities, [{ userId: "friend", label: "Friend", gameName: "Game" }]);
  for (const patch of [{ voiceOverlayActivity: 1 }, { activities: [activity, activity] }, { activities: Array(6).fill(activity) }, { activities: [{ ...activity, label: "bad\nname" }] }, { activities: [{ ...activity, gameName: "x".repeat(129) }] }]) assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), ...patch }), null);
});
test("notification IPC accepts only three opaque id/category indicators and no content fields", () => {
  const indicators = [
    { id: "notification-1", category: "mention", body: "must not cross" },
    { id: "notification-2", category: "friend_request", actor: "private-user" },
  ];
  const parsed = parseVoiceOverlaySnapshot({ ...validSnapshot(), voiceOverlayNotifications: true, notificationStatus: "ready", notifications: indicators });
  assert.deepEqual(parsed?.notifications, [
    { id: "notification-1", category: "mention" },
    { id: "notification-2", category: "friend_request" },
  ]);
  assert.equal(parsed?.voiceOverlayNotifications, true);
  for (const patch of [
    { voiceOverlayNotifications: 1 },
    { voiceOverlayNotifications: true, notificationStatus: "unknown" },
    { voiceOverlayNotifications: false, notificationStatus: "ready", notifications: [] },
    { voiceOverlayNotifications: true, notifications: Array(4).fill({ id: "n", category: "system" }) },
    { voiceOverlayNotifications: true, notificationStatus: "ready", notifications: [{ id: "n", category: "mention" }, { id: "n", category: "reply" }] },
    { voiceOverlayNotifications: true, notificationStatus: "ready", notifications: [{ id: "n", category: "dm", body: "secret" }] },
    { voiceOverlayNotifications: true, notificationStatus: "ready", notifications: [{ id: "\n", category: "system" }] },
  ]) assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), ...patch }), null);
});
test("notification click session requires its separate explicit opt-in and ready unread indicators", () => {
  const eligible = { ...validSnapshot(), voiceOverlayNotifications: true, voiceOverlayNotificationActions: true,
    notificationStatus: "ready", notifications: [{ id: "n1", category: "mention" }], notificationActionSession: "auth-gen:opaque" };
  assert.equal(parseVoiceOverlaySnapshot(eligible)?.notificationActionSession, "auth-gen:opaque");
  for (const patch of [
    { ...eligible, voiceOverlayNotificationActions: false },
    { ...eligible, voiceOverlayNotifications: false },
    { ...eligible, notificationStatus: "loading" },
    { ...eligible, notifications: [] },
  ]) assert.equal(parseVoiceOverlaySnapshot(patch), null);
  assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), voiceOverlayNotificationActions: "yes" }), null);
});

test("chat panel accepts only bounded projected messages and normalizes line endings", () => {
  const raw = { ...validSnapshot(), voiceOverlayChat: true, chatStatus: "ready", chatMessages: [
    { id: "m1", author: "Ada", text: "first\r\nsecond\rthird\tline" },
  ] };
  const parsed = parseVoiceOverlaySnapshot(raw);
  assert.deepEqual(parsed?.chatMessages, [{ id: "m1", author: "Ada", text: "first\nsecond\nthird\tline" }]);
  assert.equal(parsed?.chatStatus, "ready");
  assert.equal(parsed?.voiceOverlayChat, true);
});

test("chat panel rejects disabled data, non-ready messages, extra fields, controls, duplicates and overflow", () => {
  const base = { ...validSnapshot(), voiceOverlayChat: true, chatStatus: "ready", chatMessages: [{ id: "m1", author: "Ada", text: "hello" }] };
  const invalid = [
    { ...base, voiceOverlayChat: false },
    { ...base, chatStatus: "unavailable" },
    { ...base, chatMessages: [{ id: "m1", author: "Ada", text: "hello", html: "<b>" }] },
    { ...base, chatMessages: [{ id: "m1", author: "Ada", text: "bad\u0001text" }] },
    { ...base, chatMessages: [{ id: "m1", author: "Ada", text: "x".repeat(501) }] },
    { ...base, chatMessages: Array.from({ length: 6 }, (_, index) => ({ id: `m${index}`, author: "Ada", text: "hello" })) },
    { ...base, chatMessages: [{ id: "m1", author: "Ada", text: "hello" }, { id: "m1", author: "Bea", text: "again" }] },
    { ...base, chatStatus: "loading" },
    { ...base, voiceOverlayChat: true, chatStatus: "unavailable", chatMessages: [{ id: "m1", author: "Ada", text: "hello" }] },
    { ...base, chatStatus: undefined, chatMessages: [{ id: "m1", author: "Ada", text: "hello" }] },
  ];
  for (const value of invalid) assert.equal(parseVoiceOverlaySnapshot(value), null);
  assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), voiceOverlayChat: true, chatStatus: "unavailable", chatMessages: [] })?.chatStatus, "unavailable");
  assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), voiceOverlayChat: false, chatStatus: undefined, chatMessages: undefined })?.voiceOverlayChat, false);
});

test("chat open action requires the enabled ready chat panel and bounded opaque session", () => {
  const eligible = { ...validSnapshot(), voiceOverlayChat: true, voiceOverlayChatActions: true, chatStatus: "ready", chatMessages: [], chatActionSession: "scope:opaque" };
  assert.equal(parseVoiceOverlaySnapshot(eligible)?.chatActionSession, "scope:opaque");
  for (const patch of [
    { ...eligible, voiceOverlayChat: false },
    { ...eligible, voiceOverlayChatActions: false },
    { ...eligible, chatStatus: "unavailable" },
    { ...eligible, chatActionSession: "bad\nvalue" },
    { ...eligible, chatActionSession: "x".repeat(257) },
    { ...eligible, voiceOverlayChatActions: "yes" },
  ]) assert.equal(parseVoiceOverlaySnapshot(patch), null);
});

test("chat composer requires a separate opaque session and both explicit feature flags", () => {
  const eligible = { ...validSnapshot(), voiceOverlayChat: true, voiceOverlayChatActions: true, voiceOverlayChatCompose: true,
    chatStatus: "ready", chatMessages: [], chatActionSession: "open-scope", chatComposeSession: "compose-scope", chatComposeLabel: "general" };
  assert.equal(parseVoiceOverlaySnapshot(eligible)?.chatComposeSession, "compose-scope");
  assert.equal(parseVoiceOverlaySnapshot(eligible)?.chatComposeLabel, "general");
  for (const patch of [
    { ...eligible, voiceOverlayChat: false },
    { ...eligible, voiceOverlayChatActions: false },
    { ...eligible, voiceOverlayChatCompose: false },
    { ...eligible, chatStatus: "unavailable" },
    { ...eligible, chatComposeSession: undefined },
    { ...eligible, chatComposeSession: "bad\nvalue" },
    { ...eligible, chatComposeSession: "x".repeat(257) },
    { ...eligible, chatComposeLabel: "bad\nlabel" },
    { ...eligible, chatComposeLabel: "bad\u0085label" },
    { ...eligible, chatComposeLabel: "x".repeat(129) },
    { ...eligible, voiceOverlayChatCompose: "yes" },
  ]) assert.equal(parseVoiceOverlaySnapshot(patch), null);
  assert.equal(parseVoiceOverlaySnapshot({ ...eligible, chatComposeSession: undefined, chatComposeLabel: undefined, voiceOverlayChatCompose: false })?.voiceOverlayChatCompose, false);
});

function validSnapshot(): VoiceOverlaySnapshot {
  return {
    enabled: true,
    participants: [{ ...participant }],
    speakingOpacity: 100,
    idleOpacity: 35,
    scale: 100,
    position: "bottom-left",
    speakingOnly: false,
    voiceOverlayAvatarSize: "small",
    voiceOverlayNameDisplay: "always",
    voiceOverlayMaxParticipants: 25,
  };
}

test("voice overlay parser projects only bounded, typed fields", () => {
  const parsed = parseVoiceOverlaySnapshot({ ...validSnapshot(), ignored: { untrusted: true } });
  assert.deepEqual(parsed, validSnapshot());
  assert.equal("ignored" in (parsed as unknown as Record<string, unknown>), false);
});

test("legacy snapshots receive explicit compatibility defaults", () => {
  const {
    voiceOverlayAvatarSize: _avatarSize,
    voiceOverlayNameDisplay: _nameDisplay,
    voiceOverlayMaxParticipants: _maxParticipants,
    ...legacySnapshot
  } = validSnapshot();
  assert.deepEqual(parseVoiceOverlaySnapshot(legacySnapshot), validSnapshot());
});

test("voice widget options accept only their documented values and bounds", () => {
  assert.deepEqual(parseVoiceOverlaySnapshot({
    ...validSnapshot(),
    voiceOverlayAvatarSize: "large",
    voiceOverlayNameDisplay: "speaking",
    voiceOverlayMaxParticipants: 1,
  }), {
    ...validSnapshot(),
    voiceOverlayAvatarSize: "large",
    voiceOverlayNameDisplay: "speaking",
    voiceOverlayMaxParticipants: 1,
  });
  assert.deepEqual(parseVoiceOverlaySnapshot({
    ...validSnapshot(),
    voiceOverlayNameDisplay: "never",
    voiceOverlayMaxParticipants: 25,
  })?.voiceOverlayNameDisplay, "never");
  assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), voiceOverlayMaxParticipants: 0 })?.voiceOverlayMaxParticipants, 0);
  for (const invalidOptions of [
    { voiceOverlayAvatarSize: "medium" },
    { voiceOverlayNameDisplay: "quiet" },
    { voiceOverlayMaxParticipants: -1 },
    { voiceOverlayMaxParticipants: 26 },
    { voiceOverlayMaxParticipants: 1.5 },
    { voiceOverlayMaxParticipants: Number.NaN },
  ]) {
    assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), ...invalidOptions }), null);
  }
});

test("voice overlay parser rejects malformed settings and participants", () => {
  const invalid: unknown[] = [
    null,
    [],
    { ...validSnapshot(), enabled: 1 },
    { ...validSnapshot(), speakingOnly: "false" },
    { ...validSnapshot(), speakingOpacity: Number.NaN },
    { ...validSnapshot(), idleOpacity: 101 },
    { ...validSnapshot(), scale: Number.POSITIVE_INFINITY },
    { ...validSnapshot(), scale: 74 },
    { ...validSnapshot(), position: "bottom-right-extra" },
    { ...validSnapshot(), participants: [{ ...participant, muted: 0 }] },
    { ...validSnapshot(), participants: [{ ...participant, id: " " }] },
    { ...validSnapshot(), participants: [{ ...participant, name: "\nname" }] },
    { ...validSnapshot(), participants: [{ ...participant, avatarUrl: "javascript:alert(1)" }] },
    { ...validSnapshot(), participants: [{ ...participant, avatarUrl: "//evil.invalid/a.png" }] },
    { ...validSnapshot(), participants: [{ ...participant }, { ...participant }] },
    { ...validSnapshot(), participants: Array.from({ length: 65 }, (_, i) => ({ ...participant, id: `user-${i}` })) },
  ];
  for (const value of invalid) assert.equal(parseVoiceOverlaySnapshot(value), null);
});

class FakeTarget implements VoiceOverlayLifecycleTarget {
  loading = true;
  destroyed = false;
  hides = 0;
  delivered: VoiceOverlaySnapshot[] = [];
  callbacks: Array<() => void> = [];

  isDestroyed(): boolean { return this.destroyed; }
  isLoading(): boolean { return this.loading; }
  onDidFinishLoad(callback: () => void): void { this.callbacks.push(callback); }
  hide(): void { this.hides += 1; }
  deliver(snapshot: VoiceOverlaySnapshot): void { this.delivered.push(snapshot); }
  finishLoad(): void {
    this.loading = false;
    for (const callback of this.callbacks.splice(0)) callback();
  }
}

test("disable while loading fences the stale enabled snapshot", () => {
  const lifecycle = new VoiceOverlayLifecycle();
  const target = new FakeTarget();
  lifecycle.update(validSnapshot(), target);
  lifecycle.update({ ...validSnapshot(), enabled: false }, target);
  assert.equal(target.hides, 1);
  target.finishLoad();
  assert.deepEqual(target.delivered, []);
});

test("repeated disable and re-enable while loading reuses one listener", () => {
  const lifecycle = new VoiceOverlayLifecycle();
  const target = new FakeTarget();
  const disabled = { ...validSnapshot(), enabled: false };
  const latest = { ...validSnapshot(), position: "top-right" as const };
  lifecycle.update(validSnapshot(), target);
  lifecycle.update(disabled, target);
  lifecycle.update(latest, target);
  lifecycle.update(disabled, target);
  lifecycle.update(latest, target);
  assert.equal(target.callbacks.length, 1);
  target.finishLoad();
  assert.deepEqual(target.delivered, [latest]);
});

test("close while loading fences pending delivery and destroyed targets", () => {
  const lifecycle = new VoiceOverlayLifecycle();
  const target = new FakeTarget();
  lifecycle.update(validSnapshot(), target);
  lifecycle.close();
  target.finishLoad();
  assert.deepEqual(target.delivered, []);

  const destroyedTarget = new FakeTarget();
  destroyedTarget.loading = false;
  destroyedTarget.destroyed = true;
  lifecycle.update(validSnapshot(), destroyedTarget);
  assert.deepEqual(destroyedTarget.delivered, []);
});

test("only latest pending snapshot is delivered after load", () => {
  const lifecycle = new VoiceOverlayLifecycle();
  const target = new FakeTarget();
  const older = validSnapshot();
  const latest = { ...validSnapshot(), position: "top-right" as const };
  lifecycle.update(older, target);
  lifecycle.update(latest, target);
  assert.equal(target.callbacks.length, 1, "rapid updates should share one bounded load listener");
  target.finishLoad();
  assert.deepEqual(target.delivered, [latest]);
});

test("voice overlay IPC trusts only the live main window main frame", () => {
  const webContents = { mainFrame: {} };
  const mainWindow = { webContents, isDestroyed: () => false };
  assert.equal(isTrustedVoiceOverlaySender({ sender: webContents, senderFrame: webContents.mainFrame }, mainWindow), true);
  assert.equal(isTrustedVoiceOverlaySender({ sender: {}, senderFrame: webContents.mainFrame }, mainWindow), false);
  assert.equal(isTrustedVoiceOverlaySender({ sender: webContents, senderFrame: {} }, mainWindow), false);
  assert.equal(isTrustedVoiceOverlaySender({ sender: webContents, senderFrame: null }, mainWindow), false);
  assert.equal(isTrustedVoiceOverlaySender({ sender: webContents, senderFrame: webContents.mainFrame }, { ...mainWindow, isDestroyed: () => true }), false);
  assert.equal(isTrustedVoiceOverlaySender({ sender: webContents, senderFrame: webContents.mainFrame }, null), false);
});


test("welcome accepts a boolean preference and bounded accessibility duration, never a renderer-authored activation", () => {
  assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), voiceOverlayWelcome: true, overlayNotificationDurationMs: 20000 })?.voiceOverlayWelcome, true);
  for (const patch of [{ voiceOverlayWelcome: 1 }, { overlayNotificationDurationMs: 0 }, { overlayNotificationDurationMs: 20001 }, { overlayNotificationDurationMs: 3000.5 }, { welcome: { id: 1, expiresAt: 999999 } }, { welcomeHeight: 32 }]) assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), ...patch }), null);
  assert.equal(parseVoiceOverlaySnapshot(validSnapshot())?.voiceOverlayWelcome, undefined);
});


test("Go Live is optional bounded booleans only; renderer cannot author a native activation", () => {
  assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), voiceOverlayGoLive: true, goLiveEligible: true, goLiveSession: "room-a" })?.goLiveEligible, true);
  for (const patch of [{ voiceOverlayGoLive: 1 }, { goLiveEligible: "true" }, { voiceOverlayGoLive: true, goLiveEligible: true }, { goLiveSession: "bad\nroom" }, { goLive: { id: 1, expiresAt: 99999 } }, { goLiveHeight: 64 }]) assert.equal(parseVoiceOverlaySnapshot({ ...validSnapshot(), ...patch }), null);
});


test("notification reply metadata contains only a unique visible mention/reply subset and an explicit bounded session", () => {
  const source = { ...validSnapshot(), voiceOverlayNotifications: true, voiceOverlayNotificationActions: true, notificationStatus: "ready", notifications: [{ id: "mention", category: "mention" }, { id: "friend", category: "friend_request" }], notificationReplyIds: ["mention"], notificationReplySession: "reply-session" };
  assert.deepEqual(parseVoiceOverlaySnapshot(source)?.notificationReplyIds, ["mention"]);
  assert.deepEqual(parseVoiceOverlaySnapshot({ ...source,notifications:[{id:"dm-message",category:"message"}],notificationReplyIds:["dm-message"] })?.notificationReplyIds,["dm-message"]);
  for (const patch of [{ notificationReplyIds: ["missing"] }, { notificationReplyIds: ["friend"] }, { notificationReplyIds: ["mention", "mention"] }, { notificationReplyIds: ["mention"], notificationReplySession: undefined }, { notificationReplySession: "bad\nsession" }, { notificationReplyButtons: [{ id: "mention", row: 0 }] }, { voiceOverlayNotificationActions: false }]) assert.equal(parseVoiceOverlaySnapshot({ ...source, ...patch }), null);
});

test("compatibility is optional legacy-safe and strictly boolean",()=>{assert.equal(parseVoiceOverlaySnapshot(validSnapshot())?.voiceOverlayCompatibility,undefined);assert.equal(parseVoiceOverlaySnapshot({...validSnapshot(),voiceOverlayCompatibility:true})?.voiceOverlayCompatibility,true);for(const value of [1,"true",null,{},[]])assert.equal(parseVoiceOverlaySnapshot({...validSnapshot(),voiceOverlayCompatibility:value}),null);});

test("acknowledged and legacy snapshot application share strict trust, parse and policy boundary", () => {
 const applied:string[]=[];
 const target={setSuspended(value:boolean){applied.push(`policy:${value}`);return true;},setSnapshot(){applied.push("snapshot");}};
 assert.equal(applyAcknowledgedVoiceOverlaySnapshot({...validSnapshot(),voiceOverlayCompatibility:false},false,target),false);
 assert.equal(applyAcknowledgedVoiceOverlaySnapshot({...validSnapshot(),voiceOverlayCompatibility:"no"},true,target),false);
 assert.deepEqual(applied,[]);
 assert.equal(applyAcknowledgedVoiceOverlaySnapshot({...validSnapshot(),voiceOverlayCompatibility:false},true,target),true);
 assert.deepEqual(applied,["policy:false","snapshot"]);
 assert.equal(applyAcknowledgedVoiceOverlaySnapshot({...validSnapshot(),voiceOverlayCompatibility:true},true,{...target,setSuspended(){return false;}}),false);
 assert.equal(applied[applied.length - 1],"snapshot");
});

test("media preferences are opt-in typed booleans and count as passive HUD content",()=>{
 assert.equal(parseVoiceOverlaySnapshot({...validSnapshot(),voiceOverlayVideo:true})?.voiceOverlayVideo,true);
 assert.equal(parseVoiceOverlaySnapshot({...validSnapshot(),voiceOverlayStreams:false})?.voiceOverlayStreams,false);
 for(const key of ["voiceOverlayVideo","voiceOverlayStreams"])for(const value of [1,"true",null])assert.equal(parseVoiceOverlaySnapshot({...validSnapshot(),[key]:value}),null);
});

const transientNotice = (kind: "game_activity" | "now_playing" = "game_activity", suffix = "1") => ({ noticeId: `12345678-1234-4234-8234-${suffix.padStart(12, "0")}`, label: "Friend", gameName: "CS2", kind, expiresAt: Date.now() + 10_000 });
test("game notices are independently opt-in, expiring and display-only even in passive compatibility", () => {
  const notices = [transientNotice(), transientNotice("now_playing", "2")];
  const source = { ...validSnapshot(), voiceOverlayCompatibility: true, voiceOverlayGameActivityNotifications: true, voiceOverlayNowPlayingNotifications: false, gameActivityNotices: notices };
  assert.deepEqual(parseVoiceOverlaySnapshot(source)?.gameActivityNotices, [notices[0]]);
  assert.deepEqual(parseVoiceOverlaySnapshot({ ...source, voiceOverlayGameActivityNotifications: false })?.gameActivityNotices, []);
  assert.equal(visibleOverlayGameActivityNotices({ ...source, voiceOverlayNowPlayingNotifications: true }).length, 2);
  assert.deepEqual(parseVoiceOverlaySnapshot({ ...source, gameActivityNotices: [{ ...notices[0], expiresAt: Date.now() - 1 }] })?.gameActivityNotices, []);
  for (const field of ["voiceOverlayGameActivityNotifications", "voiceOverlayNowPlayingNotifications"]) for (const value of [1, "true", null]) assert.equal(parseVoiceOverlaySnapshot({ ...source, [field]: value }), null);
});
test("game notice transport rejects identifiers, capabilities, invalid expiry and unbounded rows/text", () => {
  const notice = transientNotice();
  const source = { ...validSnapshot(), voiceOverlayGameActivityNotifications: true };
  for (const entry of [{ ...notice, userId: "private" }, { ...notice, ticket: "private" }, { ...notice, url: "steam://run/730" },
    { ...notice, noticeId: "user-id" }, { ...notice, label: "x".repeat(81) }, { ...notice, gameName: "x".repeat(81) },
    { ...notice, label: "bad\nlabel" }, { ...notice, kind: "join" }, { ...notice, expiresAt: Infinity }, { ...notice, expiresAt: Date.now() + 21_000 }]) {
    assert.equal(parseVoiceOverlaySnapshot({ ...source, gameActivityNotices: [entry] }), null);
  }
  assert.equal(parseVoiceOverlaySnapshot({ ...source, gameActivityNotices: [notice, notice] }), null);
  assert.equal(parseVoiceOverlaySnapshot({ ...source, gameActivityNotices: Array(4).fill(notice) }), null);
});
