import assert from "node:assert/strict";
import test from "node:test";
import { OverlayGameNoticeLifecycle } from "./overlay-game-notices";
import type { OverlayGameActivityNotice, VoiceOverlaySnapshot } from "./voice-overlay-contract";
const now = 1_800_000_000_000;
const notice = (n = 1): OverlayGameActivityNotice => ({ noticeId: `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`, label: "Friend", gameName: "CS2", kind: "game_activity", expiresAt: now + 10000 });
const snapshot = (entries = [notice()]) => ({ voiceOverlayGameActivityNotifications: true, gameActivityNotices: entries } as VoiceOverlaySnapshot);
test("clear prevents delayed snapshots from resurrecting a notice until expiry", () => {
  const state = new OverlayGameNoticeLifecycle(), source = snapshot();
  assert.equal(state.current(source, now).length, 1);
  state.revoke(source.gameActivityNotices!, now);
  assert.equal(state.current(source, now + 1).length, 0);
  assert.equal(state.current(snapshot([notice(2)]), now + 1).length, 1);
  assert.equal(state.current(source, now + 10000).length, 0);
});
test("revocation saturation remains bounded and fails closed for the remaining short TTL", () => {
  const state = new OverlayGameNoticeLifecycle();
  state.revoke(Array.from({ length: 257 }, (_, i) => notice(i + 1)), now);
  assert.equal(state.current(snapshot([notice(1000)]), now + 1).length, 0);
  const fresh = { ...notice(1001), expiresAt: now + 20000 };
  assert.equal(state.current(snapshot([fresh]), now + 10000).length, 1);
});
