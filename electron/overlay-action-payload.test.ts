import assert from "node:assert/strict";
import test from "node:test";
import { chatActionPayload, notificationActionPayload, voiceActionPayload } from "./overlay-action-payload";
import type { VoiceOverlaySnapshot } from "./voice-overlay-contract";

const snapshot: VoiceOverlaySnapshot = {
  enabled: true, participants: [{ id: "private-user", name: "Private Name", avatarUrl: "", speaking: true, muted: false, deafened: false }],
  speakingOpacity: 1, idleOpacity: 0.5, scale: 1, position: "top-right", speakingOnly: false,
  voiceOverlayAvatarSize: "small", voiceOverlayNameDisplay: "always", voiceOverlayMaxParticipants: 25,
  chatMessages: [{ id: "private-message", author: "Private Author", text: "private-body" }],
  activities: [{ userId: "private-user", label: "private-activity", gameName: "private-game" }],
  notifications: [{ id: "private-notification", category: "message" }],
  chatActionSession: "open-grant", chatComposeSession: "compose-grant", chatComposeLabel: "private-channel",
  notificationActionSession: "inbox-grant", notificationReplySession: "reply-grant", voiceActionSession: "voice-grant",
};

test("chat action projection exposes compose capability only when expanded and never forwards history", () => {
  for (const expanded of [false, true]) {
    const payload = chatActionPayload(snapshot, expanded);
    const wire = JSON.stringify(payload);
    assert.equal(payload.chatActionSession, "open-grant");
    assert.equal(payload.chatComposeSession, expanded ? "compose-grant" : undefined);
    for (const secret of ["private-", "inbox-grant", "reply-grant", "voice-grant"]) assert.equal(wire.includes(secret), false);
  }
});

test("notification action projection carries selected opaque reply rows without private display data", () => {
  const payload = notificationActionPayload(snapshot, [{ id: "opaque-reply", row: 2 }]);
  assert.deepEqual(payload.notificationReplyButtons, [{ id: "opaque-reply", row: 2 }]);
  assert.equal(payload.notificationActionSession, "inbox-grant");
  assert.equal(payload.notificationReplySession, "reply-grant");
  const wire = JSON.stringify(payload);
  for (const secret of ["private-", "compose-grant", "open-grant", "voice-grant"]) assert.equal(wire.includes(secret), false);
});

test("voice action projection preserves controls while removing chat, roster and activity display data", () => {
  const before = structuredClone(snapshot);
  const payload = voiceActionPayload(snapshot, true);
  assert.equal(payload.unlocked, true);
  assert.equal(payload.voiceActionSession, "voice-grant");
  assert.deepEqual(payload.participants, []);
  assert.deepEqual(payload.activities, []);
  assert.deepEqual(payload.notifications, []);
  assert.equal(payload.chatMessages, undefined);
  assert.equal(payload.chatComposeSession, undefined);
  assert.equal(payload.chatComposeLabel, undefined);
  assert.deepEqual(snapshot, before, "building a child payload must not mutate the shared HUD snapshot");
});
