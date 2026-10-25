import assert from "node:assert/strict";
import test from "node:test";
import { calculateVoiceOverlayGeometry, constrainOverlayPosition, normalizeOverlayPosition, restoreOverlayPosition, type VoiceOverlayWorkArea } from "./voice-overlay-geometry";
import type { VoiceOverlaySnapshot } from "./voice-overlay-contract";
test("quick actions reserve unscaled hit targets and remain usable during speaking-only silence", () => {
  const area = { x: 0, y: 0, width: 1200, height: 800 };
  const source = snapshot({ speakingOnly: true, participants: [{ id: "quiet", name: "Quiet", avatarUrl: "", speaking: false, muted: false, deafened: false }], voiceOverlayQuickActions: true, voiceActionSession: "call-a" });
  const geometry = calculateVoiceOverlayGeometry(source, area)!;
  assert.equal(geometry.visibleParticipants, 0);
  assert.equal(geometry.height, 64);
  assert.equal(geometry.shouldShow, true);
  assert.equal(calculateVoiceOverlayGeometry({ ...source, voiceOverlayMaxParticipants: 0 }, area)?.shouldShow, true, "voice-list Off does not disable independent call controls");
  assert.equal(calculateVoiceOverlayGeometry({ ...source, participants: [] }, area)?.shouldShow, true, "an authenticated call session does not depend on roster loading");
  assert.equal(calculateVoiceOverlayGeometry({ ...source, participants: [], voiceActionSession: undefined }, area)?.shouldShow, false);
});
test("activity widget has an honest empty state outside voice and caps rows to physical space", () => {
  const source = snapshot({ participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayActivity: true,
    activities: Array.from({ length: 5 }, (_, index) => ({ userId: `friend-${index}`, label: "Friend", gameName: "Game" })) });
  const area = { x: -500, y: 50, width: 500, height: 240 };
  const geometry = calculateVoiceOverlayGeometry(source, area)!;
  assert.equal(geometry.shouldShow, true);
  assert.equal(geometry.activityVisible, true);
  assert.ok(geometry.activityRows >= 1 && geometry.activityRows < 5);
  assert.ok(geometry.height <= area.height);
  assert.equal(calculateVoiceOverlayGeometry({ ...source, activities: [] }, area)?.activityRows, 1);
  assert.equal(calculateVoiceOverlayGeometry({ ...source, enabled: false }, area)?.shouldShow, false);
  assert.equal(calculateVoiceOverlayGeometry(source, { ...area, height: 50 })?.shouldShow, false);
});
test("notification widget reserves independent bounded physical rows", () => {
  const source = snapshot({ participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayNotifications: true, notificationStatus: "ready",
    notifications: Array.from({ length: 3 }, (_, index) => ({ id: `notification-${index}`, category: "mention" as const })) });
  const roomy = calculateVoiceOverlayGeometry(source, { x: 0, y: 0, width: 600, height: 400 })!;
  assert.equal(roomy.shouldShow, true);
  assert.equal(roomy.notificationsVisible, true);
  assert.equal(roomy.notificationRows, 3);
  assert.equal(roomy.height, 132);
  const short = calculateVoiceOverlayGeometry(source, { x: 0, y: 0, width: 600, height: 120 })!;
  assert.equal(short.notificationsVisible, true);
  assert.ok(short.notificationRows >= 1 && short.notificationRows < 3);
  assert.ok(short.height <= 120);
  const unavailable = calculateVoiceOverlayGeometry({ ...source, notificationStatus: "unavailable", notifications: [] }, { x: 0, y: 0, width: 600, height: 400 })!;
  assert.equal(unavailable.notificationRows, 1, "status panels retain a single honest empty/error row");
  assert.equal(calculateVoiceOverlayGeometry({ ...source, voiceOverlayNotifications: false }, { x: 0, y: 0, width: 600, height: 400 })?.shouldShow, false);
});
test("chat panel is bounded to available rows and adds space above the existing lower widgets", () => {
  const source = snapshot({ participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayChat: true, chatStatus: "ready",
    chatMessages: Array.from({ length: 5 }, (_, index) => ({ id: `m-${index}`, author: "Ada", text: `message ${index}` })) });
  const roomy = calculateVoiceOverlayGeometry(source, { x: 0, y: 0, width: 600, height: 800 })!;
  assert.equal(roomy.chatVisible, true);
  assert.equal(roomy.chatRows, 5);
  assert.equal(roomy.chatHeight, 20 + 5 * 72);
  assert.equal(roomy.height, roomy.chatHeight + 16);
  assert.equal(roomy.shouldShow, true);

  const short = calculateVoiceOverlayGeometry(source, { x: 0, y: 0, width: 600, height: 200 })!;
  assert.equal(short.chatVisible, true);
  assert.equal(short.chatRows, 1);
  assert.ok(short.height <= 200);
  const tooShort = calculateVoiceOverlayGeometry(source, { x: 0, y: 0, width: 600, height: 100 })!;
  assert.equal(tooShort.chatVisible, false);
  assert.equal(tooShort.chatRows, 0);
  assert.equal(tooShort.shouldShow, false);
});

test("simultaneous chat, notifications, activity, actions and voice rows stay within workarea", () => {
  const source = snapshot({ voiceOverlayChat: true, chatStatus: "ready",
    chatMessages: Array.from({ length: 5 }, (_, index) => ({ id: `m-${index}`, author: "Ada", text: `message ${index}` })),
    voiceOverlayNotifications: true, notificationStatus: "ready",
    notifications: Array.from({ length: 3 }, (_, index) => ({ id: `n-${index}`, category: "mention" as const })),
    voiceOverlayActivity: true, activities: [{ userId: "friend", label: "Friend", gameName: "Game" }],
    voiceOverlayQuickActions: true, voiceActionSession: "call-a" });
  const area = { x: -800, y: 0, width: 600, height: 500 };
  const geometry = calculateVoiceOverlayGeometry(source, area)!;
  assert.equal(geometry.chatVisible, true);
  assert.ok(geometry.chatRows >= 1 && geometry.chatRows < 5);
  assert.equal(geometry.notificationsVisible, true);
  assert.equal(geometry.activityVisible, true);
  assert.ok(geometry.height <= area.height);
  assert.ok(geometry.x >= area.x && geometry.x + geometry.width <= area.x + area.width);
  assert.ok(geometry.y >= area.y && geometry.y + geometry.height <= area.y + area.height);
});
test("normalized placement follows a resized game without leaving its work area", () => {
  const size = { width: 200, height: 100 };
  const point = normalizeOverlayPosition({ x: -700, y: 250 }, size, { x: -1000, y: 0, width: 800, height: 600 });
  assert.deepEqual(point, { x: 0.5, y: 0.5 });
  assert.deepEqual(restoreOverlayPosition(point, size, { x: 100, y: 200, width: 400, height: 300 }), { x: 200, y: 300 });
  assert.deepEqual(normalizeOverlayPosition({ x: 10, y: 10 }, size, { x: 0, y: 0, width: 100, height: 50 }), { x: 0, y: 0 });
});
test("dragging stays inside negative-coordinate game bounds and clamps oversized widgets", () => {
  const area = { x: -1200, y: -100, width: 800, height: 600 };
  assert.deepEqual(constrainOverlayPosition({ x: 500, y: -200 }, { width: 200, height: 100 }, area), { x: -600, y: -100 });
  assert.deepEqual(constrainOverlayPosition({ x: -1000, y: 100 }, { width: 200, height: 100 }, area), { x: -1000, y: 100 });
  assert.deepEqual(constrainOverlayPosition({ x: 500, y: 500 }, { width: 900, height: 700 }, area), { x: -1200, y: -100 });
});

function snapshot(overrides: Partial<VoiceOverlaySnapshot> = {}): VoiceOverlaySnapshot {
  return {
    enabled: true,
    participants: Array.from({ length: 25 }, (_, i) => ({
      id: `u-${i}`, name: `User ${i}`, avatarUrl: "", speaking: true, muted: false, deafened: false,
    })),
    speakingOpacity: 100,
    idleOpacity: 35,
    scale: 100,
    position: "bottom-right",
    speakingOnly: false,
    voiceOverlayAvatarSize: "small",
    voiceOverlayNameDisplay: "always",
    voiceOverlayMaxParticipants: 25,
    ...overrides,
  };
}

const largeArea: VoiceOverlayWorkArea = { x: 0, y: 0, width: 3840, height: 2160 };

test("geometry sizes to requested rows, avatar size, scale, and root spacing", () => {
  const one = calculateVoiceOverlayGeometry(snapshot({ participants: snapshot().participants.slice(0, 1) }), largeArea)!;
  assert.equal(one.width, 296);
  assert.equal(one.height, 52);
  assert.equal(one.visibleParticipants, 1);

  const large25 = calculateVoiceOverlayGeometry(snapshot({ voiceOverlayAvatarSize: "large", scale: 150 }), largeArea)!;
  assert.equal(large25.width, 436);
  assert.equal(large25.height, 2032);
  assert.equal(large25.visibleParticipants, 25);
  assert.equal(large25.shouldShow, true);

  const small25 = calculateVoiceOverlayGeometry(snapshot(), largeArea)!;
  assert.equal(small25.height, 1060);
});

test("0 participants and no speaking-only matches hide the overlay", () => {
  const off = calculateVoiceOverlayGeometry(snapshot({ voiceOverlayMaxParticipants: 0 }), largeArea)!;
  assert.equal(off.visibleParticipants, 0);
  assert.equal(off.shouldShow, false);
  const none = calculateVoiceOverlayGeometry(snapshot({ participants: [] }), largeArea)!;
  assert.equal(none.shouldShow, false);
  const silent = calculateVoiceOverlayGeometry(snapshot({ speakingOnly: true, participants: snapshot().participants.map((p) => ({ ...p, speaking: false })) }), largeArea)!;
  assert.equal(silent.visibleParticipants, 0);
  assert.equal(silent.shouldShow, false);
});

test("scale variants remain bounded by workarea and reduce effective cap when needed", () => {
  for (const scale of [75, 100, 150]) {
    const geometry = calculateVoiceOverlayGeometry(snapshot({ scale, voiceOverlayAvatarSize: "large" }), { x: -1920, y: 0, width: 1920, height: 1080 })!;
    assert.ok(geometry.visibleParticipants > 0);
    assert.ok(geometry.visibleParticipants <= 25);
    assert.ok(geometry.effectiveMaxParticipants <= 25);
    assert.ok(geometry.x >= -1920 && geometry.x + geometry.width <= 0);
    assert.ok(geometry.y >= 0 && geometry.y + geometry.height <= 1080);
  }
  const constrained = calculateVoiceOverlayGeometry(snapshot({ voiceOverlayAvatarSize: "large" }), { x: 0, y: 0, width: 400, height: 300 })!;
  assert.ok(constrained.visibleParticipants < 25);
  assert.ok(constrained.shouldShow);
});

test("all four corners and negative-coordinate/tiny workareas stay inside bounds", () => {
  const area = { x: -1280, y: -200, width: 1280, height: 1024 };
  for (const position of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
    const rect = calculateVoiceOverlayGeometry(snapshot({ position, participants: snapshot().participants.slice(0, 1) }), area)!;
    assert.ok(rect.x >= area.x && rect.x + rect.width <= area.x + area.width);
    assert.ok(rect.y >= area.y && rect.y + rect.height <= area.y + area.height);
    if (position.endsWith("right")) assert.equal(rect.x + rect.width, area.x + area.width - 24);
    if (position.endsWith("left")) assert.equal(rect.x, area.x + 24);
    if (position.startsWith("bottom")) assert.equal(rect.y + rect.height, area.y + area.height - 24);
    if (position.startsWith("top")) assert.equal(rect.y, area.y + 24);
  }
  const tinyArea = { x: -5, y: -9, width: 30, height: 20 };
  const tiny = calculateVoiceOverlayGeometry(snapshot(), tinyArea)!;
  assert.ok(tiny.width <= tinyArea.width && tiny.height <= tinyArea.height);
  assert.ok(tiny.x >= tinyArea.x && tiny.x + tiny.width <= tinyArea.x + tinyArea.width);
  assert.ok(tiny.y >= tinyArea.y && tiny.y + tiny.height <= tinyArea.y + tinyArea.height);
  assert.equal(tiny.shouldShow, false);
  const narrow = calculateVoiceOverlayGeometry(snapshot({ participants: snapshot().participants.slice(0, 1) }), { x: -20, y: 0, width: 100, height: 500 })!;
  assert.equal(narrow.visibleParticipants, 0, "a workarea too narrow for the CSS widget should hide instead of clipping rows");
  assert.equal(narrow.shouldShow, false);
  assert.equal(calculateVoiceOverlayGeometry(snapshot(), { x: 0, y: 0, width: Number.NaN, height: 10 }), null);
});


test("welcome reserves a bounded row without creating an overlay or displacing actions on tiny workareas", () => {
  const area = { x: 0, y: 0, width: 900, height: 700 };
  const original = snapshot({ voiceOverlayQuickActions: true, voiceActionSession: "call", participants: [{ id: "one", name: "One", avatarUrl: "", speaking: true, muted: false, deafened: false }] });
  const base = calculateVoiceOverlayGeometry(original, area)!;
  const withWelcome = calculateVoiceOverlayGeometry({ ...original, voiceOverlayWelcome: true }, area)!;
  assert.equal(withWelcome.welcomeHeight, 32);
  assert.equal(withWelcome.height, base.height + 32);
  assert.equal(calculateVoiceOverlayGeometry({ ...original, voiceOverlayWelcome: true, participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayQuickActions: false }, area)?.shouldShow, false);
  const tiny = calculateVoiceOverlayGeometry({ ...original, voiceOverlayWelcome: true }, { ...area, height: 115 })!;
  assert.equal(tiny.welcomeHeight, 0);
  assert.equal(tiny.shouldShow, true);
  assert.ok(tiny.height <= 115);
});


test("Go Live guidance reserves bounded room only for an eligible game overlay and never creates content", () => {
  const source = snapshot({ voiceOverlayMode: "game", voiceOverlayGoLive: true, goLiveEligible: true, voiceOverlayWelcome: true, participants: [{ id: "one", name: "One", avatarUrl: "", speaking: true, muted: false, deafened: false }] });
  const area = { x: 0, y: 0, width: 900, height: 700 };
  const geometry = calculateVoiceOverlayGeometry(source, area)!;
  assert.equal(geometry.goLiveHeight, 64); assert.equal(geometry.welcomeHeight, 32);
  assert.equal(calculateVoiceOverlayGeometry({ ...source, goLiveEligible: false }, area)?.goLiveHeight, 0);
  assert.equal(calculateVoiceOverlayGeometry({ ...source, voiceOverlayMode: "desktop" }, area)?.goLiveHeight, 0);
  assert.equal(calculateVoiceOverlayGeometry(source, { ...area, height: 180 })?.goLiveHeight, 0);
  assert.equal(calculateVoiceOverlayGeometry({ ...source, participants: [], voiceOverlayMaxParticipants: 0 }, area)?.shouldShow, false);
});

test("opt-in media-only HUD reserves passive bounded space without participant/action requirements",()=>{
 const source=snapshot({participants:[],voiceOverlayMaxParticipants:0,voiceOverlayVideo:true});
 for(const area of [{x:0,y:0,width:1200,height:800},{x:-300,y:10,width:280,height:220},{x:0,y:0,width:50,height:80}]){
  const geometry=calculateVoiceOverlayGeometry(source,area)!;
  assert.ok(geometry.mediaHeight<=320);assert.ok(geometry.height<=area.height);assert.ok(geometry.width<=area.width);
  assert.equal(geometry.shouldShow,geometry.mediaHeight>0);
 }
 const off=calculateVoiceOverlayGeometry({...source,voiceOverlayVideo:false},{x:0,y:0,width:1200,height:800})!;assert.equal(off.mediaHeight,0);assert.equal(off.shouldShow,false);
});



test("transient game notices use only spare room without shrinking voice or media", () => {
  const notices = Array.from({ length: 3 }, (_, i) => ({ noticeId: `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`, label: "Friend", gameName: "CS2", kind: "game_activity" as const, expiresAt: Date.now() + 10000 }));
  const source = snapshot({ participants: snapshot().participants.slice(0, 5), voiceOverlayMode: "game", voiceOverlayVideo: true });
  for (const height of [140, 300, 500, 720, 1080]) {
    const area = { x: 0, y: 0, width: 1280, height };
    const before = calculateVoiceOverlayGeometry(source, area)!;
    const after = calculateVoiceOverlayGeometry({ ...source, voiceOverlayGameActivityNotifications: true, gameActivityNotices: notices }, area)!;
    assert.equal(after.visibleParticipants, before.visibleParticipants); assert.equal(after.mediaHeight, before.mediaHeight);
    assert.ok(after.gameActivityNoticeRows >= 0 && after.gameActivityNoticeRows <= 3); assert.ok(after.height <= area.height);
  }
  const noticesOnly = calculateVoiceOverlayGeometry(snapshot({ participants: [], voiceOverlayMaxParticipants: 0, voiceOverlayGameActivityNotifications: true, gameActivityNotices: notices }), { x: 0, y: 0, width: 600, height: 500 })!;
  assert.equal(noticesOnly.gameActivityNoticeRows, 3); assert.equal(noticesOnly.shouldShow, true);
});
