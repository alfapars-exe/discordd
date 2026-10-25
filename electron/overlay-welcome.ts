export interface OverlayWelcomeNotice { id: number; expiresAt: number }

/** Main-owned actual window activations, never renderer enabled-state transitions. */
export class OverlayWelcomeLifecycle {
  private context: string | null = null;
  private sequence = 0;
  private notice: OverlayWelcomeNotice | null = null;

  shown(context: string, enabled: boolean, now: number, durationMs = 5000): OverlayWelcomeNotice | null {
    if (this.context !== context) {
      this.context = context;
      this.notice = enabled ? { id: ++this.sequence, expiresAt: now + Math.max(3000, Math.min(20000, durationMs)) } : null;
    }
    if (!enabled) this.notice = null;
    return this.current(now);
  }

  current(now: number): OverlayWelcomeNotice | null {
    if (this.notice && this.notice.expiresAt <= now) this.notice = null;
    return this.notice ? { ...this.notice } : null;
  }

  dismiss(): void { this.notice = null; }

  hide(): void { this.context = null; this.notice = null; }
}
