import { describe, expect, it } from "vitest";
import { OverlayGameNoticeTracker, type OverlayGameNoticeInput } from "./overlayGameNotices";
import type { AuthorizedOverlayActivity } from "./overlayActivity";

const game = (id: string, canonical = false) => ({ id, name: "CS2", started_at: `2026-10-25T12:00:0${id === "old" ? 0 : 1}Z`, ...(canonical ? { canonical_game_id: "steam:730" as const } : {}) });
const activity = (id = "new", canonical = false, userId = "friend"): AuthorizedOverlayActivity => ({ userId, label: "Friend", gameName: "CS2", revision: 2, game: game(id, canonical) });
const input = (patch: Partial<OverlayGameNoticeInput> = {}): OverlayGameNoticeInput => ({ scope: "owner:1:epoch", ready: true, gameEnabled: true, nowPlayingEnabled: true, now: 1000, durationMs: 5000, activities: [activity("old")], ...patch });
function fixture() { const tracker = new OverlayGameNoticeTracker(); tracker.reconcile(input()); return tracker; }
describe("transient overlay game notice tracker", () => {
  it("hydrates a baseline and ignores stored entry markers on remount", () => {
    const tracker = new OverlayGameNoticeTracker();
    expect(tracker.reconcile(input(), [{ userId: "friend", game: game("old") }])).toEqual([]);
    expect(tracker.reconcile(input())).toEqual([]);
  });
  it("notifies once for a live transition; heartbeats/repeated revision delivery do not replay", () => {
    const tracker = fixture(), next = activity();
    const result = tracker.reconcile(input({ activities: [next] }), [next]);
    expect(result).toHaveLength(1); expect(result[0].kind).toBe("game_activity");
    expect(tracker.reconcile(input({ activities: [next], now: 2000 }), [next])).toEqual(result);
    expect(tracker.reconcile(input({ activities: [next], now: 7000 }), [next])).toEqual([]);
  });
  it("matches explicit CS2 canonical markers, never equal names or local registration IDs", () => {
    for (const canonical of [false, true]) {
      const tracker = fixture(), next = activity("new", canonical);
      const result = tracker.reconcile(input({ activities: [next], selfCanonicalGameId: "steam:730" }), [next]);
      expect(result[0].kind).toBe(canonical ? "now_playing" : "game_activity");
    }
    const tracker = fixture(), next = activity("old"); next.game.started_at = "2026-10-25T12:00:09Z";
    expect(tracker.reconcile(input({ activities: [next], gameEnabled: false, selfCanonicalGameId: "steam:730" }), [next])).toEqual([]);
  });
  it("keeps the two device preferences independent and prioritizes one same-game row", () => {
    for (const [general, same, expected] of [[true, true, "now_playing"], [true, false, "game_activity"], [false, true, "now_playing"], [false, false, null]] as const) {
      const tracker = fixture(), next = activity("new", true);
      const rows = tracker.reconcile(input({ activities: [next], gameEnabled: general, nowPlayingEnabled: same, selfCanonicalGameId: "steam:730" }), [next]);
      expect(rows).toHaveLength(expected ? 1 : 0); if (expected) expect(rows[0].kind).toBe(expected);
    }
  });
  it("suppressed events are consumed and never replay when ready or a toggle returns", () => {
    const tracker = fixture(), next = activity();
    expect(tracker.reconcile(input({ activities: [next], ready: false }), [next])).toEqual([]);
    expect(tracker.reconcile(input({ activities: [next] }), [next])).toEqual([]);
    const another = activity("different");
    expect(tracker.reconcile(input({ activities: [another], gameEnabled: false, nowPlayingEnabled: false }), [another])).toEqual([]);
    expect(tracker.reconcile(input({ activities: [another] }), [another])).toEqual([]);
  });
  it("privacy/source removal clears immediately and cannot resurrect the old transition", () => {
    const tracker = fixture(), next = activity(); tracker.reconcile(input({ activities: [next] }), [next]);
    expect(tracker.reconcile(input({ activities: [] }))).toEqual([]);
    expect(tracker.reconcile(input({ activities: [next] }), [next])).toEqual([]);
    const changed = activity("different");
    expect(tracker.reconcile(input({ activities: [changed] }), [changed])).toHaveLength(1);
  });
  it("bounds rows, duration and labels, and sends no user/source/ticket/Steam identifiers", () => {
    const tracker = fixture();
    const values = [0, 1, 2, 3].map(i => ({ ...activity(`new-${i}`, false, `private-user-${i}`), label: "L".repeat(100), gameName: "G".repeat(100) }));
    const rows = tracker.reconcile(input({ activities: values, durationMs: 99_000 }), values);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["expiresAt", "gameName", "kind", "label", "noticeId"]);
      expect(row.noticeId).toMatch(/^[0-9a-f-]{36}$/); expect(row.label).toHaveLength(80); expect(row.gameName).toHaveLength(80); expect(row.expiresAt).toBe(21_000);
      expect(JSON.stringify(row)).not.toContain("private-user");
    }
  });
  it("scope/epoch changes retire old notices and establish a new baseline", () => {
    const tracker = fixture(), next = activity(); tracker.reconcile(input({ activities: [next] }), [next]);
    expect(tracker.reconcile(input({ scope: "owner:2:new-epoch", activities: [next] }), [next])).toEqual([]);
    expect(tracker.reconcile(input({ scope: null }))).toEqual([]);
  });
});
