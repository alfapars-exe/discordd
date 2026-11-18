import assert from "node:assert/strict";
import test from "node:test";
import { overlayHUDPayload } from "./overlay-hud-payload";
import { calculateVoiceOverlayGeometry } from "./voice-overlay-geometry";
import type { VoiceOverlaySnapshot } from "./voice-overlay-contract";

const snapshot: VoiceOverlaySnapshot = {
  enabled: true, participants: [], speakingOpacity: 1, idleOpacity: 0.5, scale: 1,
  position: "top-right", speakingOnly: false, voiceOverlayAvatarSize: "small",
  voiceOverlayNameDisplay: "always", voiceOverlayMaxParticipants: 25,
  voiceOverlayNotificationActions: true, chatStatus: "ready",
  chatMessages: ["old", "middle", "new"].map(id => ({ id, author: "fixture", text: id })),
  activities: ["first", "second"].map(userId => ({ userId, label: userId, gameName: userId })),
  notifications: [{ id: "first", category: "message" }, { id: "second", category: "mention" }],
};
const state = { gameActivityNotices: [], goLive: null, welcome: null, notificationActionsUnavailable: true, unlocked: false, layoutSaveFailed: true, quickActionsUnavailable: false };

test("HUD projection bounds chat from the newest edge and other rows from their first edge", () => {
  const geometry = calculateVoiceOverlayGeometry(snapshot, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.ok(geometry);
  const before = structuredClone(snapshot);
  const payload = overlayHUDPayload(snapshot, { ...geometry, chatVisible: true, chatRows: 2, activityVisible: true, activityRows: 1, notificationsVisible: true, notificationRows: 1, effectiveMaxParticipants: 3 }, state);
  assert.deepEqual(payload.chatMessages?.map(message => message.id), ["middle", "new"]);
  assert.deepEqual(payload.activities.map(activity => activity.userId), ["first"]);
  assert.deepEqual(payload.notifications.map(notification => notification.id), ["first"]);
  assert.equal(payload.voiceOverlayMaxParticipants, 3);
  assert.equal(payload.notificationActionsUnavailable, true);
  assert.equal(payload.layoutSaveFailed, true);
  assert.deepEqual(snapshot, before);
});

test("missing geometry suppresses all display panels without changing configured preferences", () => {
  const payload = overlayHUDPayload(snapshot, null, state);
  assert.equal(payload.voiceOverlayChat, false);
  assert.equal(payload.chatMessages, undefined);
  assert.equal(payload.chatStatus, undefined);
  assert.deepEqual(payload.activities, []);
  assert.deepEqual(payload.notifications, []);
  assert.deepEqual(payload.gameActivityNotices, []);
  assert.equal(payload.mediaHeight, 0);
  assert.equal(payload.voiceOverlayMaxParticipants, 0);
  assert.equal(snapshot.voiceOverlayMaxParticipants, 25);
  assert.equal(overlayHUDPayload({ ...snapshot, voiceOverlayNotificationActions: false }, null, state).notificationActionsUnavailable, false);
});
