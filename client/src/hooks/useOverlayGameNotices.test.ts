import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearTokens, getAuthGeneration } from "../api/client";
import { useAuthStore } from "../stores/authStore";
import { useBlockStore } from "../stores/blockStore";
import { useFriendStore } from "../stores/friendStore";
import { useGameActivityStore } from "../stores/gameActivityStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import { usePresenceStore } from "../stores/presenceStore";
import { useVoiceStore } from "../stores/voiceStore";
import { beginGameActivityMutation } from "../utils/gameActivityMutation";
import { attachOverlayGameNotices, getLiveOverlayGameNotices } from "./useOverlayGameNotices";

const game = { id: "local-friend", name: "CS2", started_at: "2026-10-25T12:00:00Z", canonical_game_id: "steam:730" as const };
let dispose: (() => void) | undefined;
const clear = vi.fn(async () => {});
beforeEach(() => {
  clearTokens(); clear.mockClear();
  useAuthStore.setState({ user: { id: "viewer" } as never, manualStatus: "online" });
  useGameActivityStore.getState().start("epoch");
  useFriendStore.setState({ ownerId: "viewer", authGeneration: getAuthGeneration(), friendsStatus: "ready", friends: [{ user_id: "friend", status: "accepted", display_name: "Friend", username: "friend", user_status: "online" }] as never });
  useBlockStore.setState({ ownerId: "viewer", authGeneration: getAuthGeneration(), snapshotReady: true, blockedUserIds: [] });
  usePreferencesStore.setState({ accountId: "viewer", isLoaded: true, data: { privacy: { shareGameActivity: false, ignoredUsers: {} } } });
  usePresenceStore.setState({ statusByUserId: {} });
  useVoiceStore.setState({ voiceOverlayEnabled: true, voiceOverlayGameActivityNotifications: true, voiceOverlayNowPlayingNotifications: false });
  Object.defineProperty(window, "electronAPI", { configurable: true, value: { clearOverlayGameNotices: clear, getRegisteredGameActivity: vi.fn(async () => ({ enabled: true, game: { id: "private-own", name: "Local label", canonicalGameId: "steam:730" } })) } });
});
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); Object.defineProperty(window, "electronAPI", { configurable: true, value: undefined }); });
const emit = (revision = 1, patch: object = {}) => useGameActivityStore.getState().apply({ epoch: "epoch", user_id: "friend", game, revision, transition: true, ...patch });
it("consumes only new live markers, not already stored markers or snapshot grants", () => {
  emit(); dispose = attachOverlayGameNotices(true, vi.fn()); expect(getLiveOverlayGameNotices()).toEqual([]);
  emit(2, { game: { ...game, started_at: "2026-10-25T12:00:01Z" }, transition: false }); expect(getLiveOverlayGameNotices()).toEqual([]);
  emit(3, { game: { ...game, started_at: "2026-10-25T12:00:02Z" } }); expect(getLiveOverlayGameNotices()).toHaveLength(1);
});
it("same-game matching works with private own activity via the cached local getter", async () => {
  useVoiceStore.setState({ voiceOverlayGameActivityNotifications: false, voiceOverlayNowPlayingNotifications: true });
  dispose = attachOverlayGameNotices(true, vi.fn()); await Promise.resolve(); await Promise.resolve();
  expect(usePreferencesStore.getState().get<{ shareGameActivity: boolean }>("privacy")?.shareGameActivity).toBe(false);
  emit(); expect(getLiveOverlayGameNotices()[0]?.kind).toBe("now_playing");
  expect(JSON.stringify(getLiveOverlayGameNotices())).not.toContain("private-own");
});
it("direct block/privacy/source revocation clears native before any React rendering", () => {
  dispose = attachOverlayGameNotices(true, vi.fn()); emit(); expect(getLiveOverlayGameNotices()).toHaveLength(1);
  usePreferencesStore.setState({ data: { privacy: { ignoredUsers: { friend: true } } } });
  expect(clear).toHaveBeenCalledTimes(1); expect(getLiveOverlayGameNotices()).toEqual([]);
  usePreferencesStore.setState({ data: { privacy: { ignoredUsers: {} } } }); emit(2); expect(getLiveOverlayGameNotices()).toEqual([]);
  emit(3, { game: { ...game, started_at: "2026-10-25T12:00:03Z" } }); expect(getLiveOverlayGameNotices()).toHaveLength(1);
  emit(4, { game: null }); expect(getLiveOverlayGameNotices()).toEqual([]); expect(clear).toHaveBeenCalledTimes(2);
});
it("account, block and relationship provenance fail closed while DND suppression does not replay", () => {
  dispose = attachOverlayGameNotices(true, vi.fn()); useAuthStore.setState({ manualStatus: "dnd" }); emit();
  useAuthStore.setState({ manualStatus: "online" }); expect(getLiveOverlayGameNotices()).toEqual([]);
  useBlockStore.setState({ authGeneration: getAuthGeneration() + 1 }); emit(2, { game: { ...game, started_at: "2026-10-25T12:00:02Z" } }); expect(getLiveOverlayGameNotices()).toEqual([]);
  useBlockStore.setState({ authGeneration: getAuthGeneration() }); useFriendStore.setState({ friendsStatus: "loading" }); emit(3, { game: { ...game, started_at: "2026-10-25T12:00:03Z" } }); expect(getLiveOverlayGameNotices()).toEqual([]);
  useAuthStore.setState({ user: { id: "other" } as never }); expect(getLiveOverlayGameNotices()).toEqual([]);
});
it("does not convert server-only grants into global friend notices", () => {
  dispose = attachOverlayGameNotices(true, vi.fn()); emit(1, { server_id: "private-server" }); expect(getLiveOverlayGameNotices()).toEqual([]);
});
it("local game opt-out immediately revokes same-game metadata without sending private source IDs", async () => {
  useVoiceStore.setState({ voiceOverlayGameActivityNotifications: false, voiceOverlayNowPlayingNotifications: true });
  dispose = attachOverlayGameNotices(true, vi.fn()); await Promise.resolve(); await Promise.resolve(); emit();
  expect(getLiveOverlayGameNotices()).toHaveLength(1);
  const end = beginGameActivityMutation("private-own");
  expect(getLiveOverlayGameNotices()).toEqual([]); expect(clear).toHaveBeenCalled(); end();
});
function addSecondFriend() {
  const first = useFriendStore.getState().friends[0];
  useFriendStore.setState({ friends: [first, { ...first, user_id: "friend-b", username: "second", display_name: "Second" }] });
}
it("append preserves IDs; privacy-revoking A remints surviving B without extending its expiry", () => {
  addSecondFriend(); dispose = attachOverlayGameNotices(true, vi.fn()); emit();
  const firstId = getLiveOverlayGameNotices()[0].noticeId;
  emit(1, { user_id: "friend-b" });
  const before = getLiveOverlayGameNotices();
  expect(before).toHaveLength(2); expect(before[1].noticeId).toBe(firstId); expect(clear).not.toHaveBeenCalled();
  useBlockStore.setState({ blockedUserIds: ["friend"] });
  const after = getLiveOverlayGameNotices();
  expect(clear).toHaveBeenCalledTimes(1); expect(after).toHaveLength(1);
  expect(after[0].label).toBe("Second"); expect(after[0].noticeId).not.toBe(before[0].noticeId); expect(after[0].expiresAt).toBe(before[0].expiresAt);
  emit(2, { user_id: "friend-b" }); expect(getLiveOverlayGameNotices()).toEqual(after);
});
it("natural expiry of A preserves B's native transport ID and original deadline without clearing", () => {
  vi.useFakeTimers(); addSecondFriend(); dispose = attachOverlayGameNotices(true, vi.fn()); emit();
  vi.advanceTimersByTime(1000); emit(1, { user_id: "friend-b" });
  const second = getLiveOverlayGameNotices()[0];
  vi.advanceTimersByTime(4250);
  expect(getLiveOverlayGameNotices()).toEqual([second]); expect(clear).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000); expect(getLiveOverlayGameNotices()).toEqual([]); expect(clear).not.toHaveBeenCalled();
});
