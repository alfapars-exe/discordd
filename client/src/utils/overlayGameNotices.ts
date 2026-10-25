import type { AuthorizedOverlayActivity, OverlayActivityGame } from "./overlayActivity";

export type OverlayGameNotice = { noticeId: string; label: string; gameName: string; kind: "game_activity" | "now_playing"; expiresAt: number };
export type OverlayGameTransition = { userId: string; game: OverlayActivityGame };
export type OverlayGameNoticeInput = {
  scope: string | null; ready: boolean; gameEnabled: boolean; nowPlayingEnabled: boolean;
  selfCanonicalGameId?: "steam:730"; activities: readonly AuthorizedOverlayActivity[];
  now: number; durationMs: number;
};
const signature = (game: OverlayActivityGame) => JSON.stringify([game.id, game.started_at, game.canonical_game_id ?? null]);
/** Local transient metadata only. No persisted notification rows or launch authority. */
export class OverlayGameNoticeTracker {
  private scope: string | null = null;
  private seen = new Map<string, string>();
  private notices: Array<{ value: OverlayGameNotice; signature: string; userId: string }> = [];
  /** A native clear tombstones transport IDs; surviving logical notices retain
   * their original expiry and transition identity while receiving fresh IDs. */
  remintRetainedNoticeIds(): OverlayGameNotice[] {
    this.notices = this.notices.map(item => ({ ...item, value: { ...item.value, noticeId: crypto.randomUUID() } }));
    return this.notices.map(item => item.value);
  }
  reconcile(input: OverlayGameNoticeInput, live: readonly OverlayGameTransition[] = []): OverlayGameNotice[] {
    if (!input.scope || input.scope !== this.scope) {
      this.scope = input.scope; this.seen.clear(); this.notices = [];
      // Hook hydration/remount always seeds a baseline. Existing entry markers
      // are never interpreted as newly delivered transitions.
      for (const item of input.activities) this.seen.set(item.userId, signature(item.game));
      return [];
    }
    const allowed = new Map(input.activities.map(item => [item.userId, item]));
    this.notices = this.notices.filter(item => {
      const current = allowed.get(item.userId);
      return input.ready && item.value.expiresAt > input.now && current && signature(current.game) === item.signature
        && (item.value.kind === "game_activity" ? input.gameEnabled : input.nowPlayingEnabled && input.selfCanonicalGameId === "steam:730" && current.game.canonical_game_id === "steam:730");
    }).map(item => ({ ...item, value: { ...item.value, label: allowed.get(item.userId)!.label.slice(0, 80), gameName: allowed.get(item.userId)!.gameName.slice(0, 80) } }));
    for (const transition of live) {
      const next = signature(transition.game), previous = this.seen.get(transition.userId);
      if (this.seen.size >= 10_000 && !this.seen.has(transition.userId)) continue;
      this.seen.set(transition.userId, next);
      if (previous === next || !input.ready) continue;
      const item = allowed.get(transition.userId);
      if (!item || signature(item.game) !== next) continue;
      const sameGame = input.selfCanonicalGameId === "steam:730" && item.game.canonical_game_id === "steam:730";
      const kind: OverlayGameNotice["kind"] | null = sameGame && input.nowPlayingEnabled ? "now_playing" : input.gameEnabled ? "game_activity" : null;
      if (!kind) continue;
      const duration = Math.max(3000, Math.min(20_000, Number.isFinite(input.durationMs) ? input.durationMs : 5000));
      this.notices = [{ value: { noticeId: crypto.randomUUID(), label: item.label.slice(0, 80), gameName: item.gameName.slice(0, 80), kind, expiresAt: input.now + duration }, userId: item.userId, signature: next }, ...this.notices.filter(existing => existing.userId !== item.userId)].slice(0, 3);
    }
    return this.notices.map(item => item.value);
  }
}
