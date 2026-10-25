import { visibleOverlayGameActivityNotices, type OverlayGameActivityNotice, type VoiceOverlaySnapshot } from "./voice-overlay-contract";
/** Bounded, short-lived tombstones prevent delayed snapshots from undoing an explicit clear. */
export class OverlayGameNoticeLifecycle {
  private revoked = new Map<string, number>();
  private blockedUntil = 0;
  private prune(now: number): void { for (const [id, expires] of this.revoked) if (expires <= now) this.revoked.delete(id); }
  current(snapshot: VoiceOverlaySnapshot, now = Date.now()): OverlayGameActivityNotice[] {
    this.prune(now);
    return now < this.blockedUntil ? [] : visibleOverlayGameActivityNotices(snapshot, now).filter(notice => !this.revoked.has(notice.noticeId));
  }
  revoke(notices: OverlayGameActivityNotice[], now = Date.now()): void {
    this.prune(now);
    for (const notice of notices) if (notice.expiresAt > now && notice.expiresAt <= now + 20_000) this.revoked.set(notice.noticeId, notice.expiresAt);
    if (this.revoked.size > 256) {
      this.blockedUntil = Math.max(this.blockedUntil, ...this.revoked.values());
      this.revoked.clear();
    }
  }
}
