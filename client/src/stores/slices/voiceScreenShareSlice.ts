/**
 * voiceScreenShareSlice — screen share watch/focus state.
 *
 * Watch state is intentionally not persisted: subscriptions are per-session,
 * opt-in per click to avoid unnecessary bandwidth on join.
 */

import type { StateCreator } from "zustand";
import { playJoinSound, playLeaveSound } from "../../utils/sounds";
import type { VoiceStore } from "../voiceStore";

/**
 * Per-publisher receiver-side quality grade, derived from
 * useScreenShareReceiverStats every 10 s. Drives the colored badge on
 * the screen-share panel so the viewer can tell "is this bad on my
 * side or genuinely a bad stream" without reading logs.
 *   - good: high bitrate, ~0 packet loss, no freezes
 *   - fair: noticeable loss / occasional freeze
 *   - poor: heavy loss, stalled jitter buffer, or major freezes
 */
export type ScreenShareQualityGrade = "good" | "fair" | "poor";

/**
 * Sustained reason the publisher's encoder is dropping quality. Mirrors
 * RTCRtpSender's qualityLimitationReason but with our own hysteresis
 * applied (one 10 s spike doesn't flash the banner — we require two
 * consecutive samples to set, and two consecutive clean samples to clear).
 *
 * "none" is the absence of a warning; we don't store it (entry is just
 * cleared). "other" is grouped with "none" because it doesn't suggest a
 * user-actionable fix.
 */
export type ScreenShareLimitationReason = "cpu" | "bandwidth";

export type VoiceScreenShareSlice = {
  /** streamer user IDs we're actively subscribed to */
  watchingScreenShares: Record<string, boolean>;
  /**
   * streamerUserID -> list of viewer user IDs (maintained via WS events).
   *
   * Previously this was a count only (`Record<string, number>`). The server
   * already broadcasts each viewer's identity in `screen_share_viewer_update`
   * (with `viewer_user_id` + `action: "join" | "leave"`), so storing the full
   * set lets the broadcaster's UI render "who is watching me" — and a count
   * is still trivially `viewers.length` for the existing sidebar badge.
   */
  screenShareViewers: Record<string, string[]>;
  /**
   * publisherUserID -> last observed quality grade. Written by
   * useScreenShareReceiverStats; read by the per-panel badge.
   * Not persisted — purely transient per-session derived state.
   */
  screenShareQualityGradeByPublisher: Record<string, ScreenShareQualityGrade>;
  /**
   * When the local user is broadcasting and the encoder reports a
   * sustained limitation (cpu / bandwidth), useScreenShareStats writes
   * it here. The broadcaster surface reads this to render an
   * actionable banner ("CPU yetersiz — Düşük Gecikme moduna geç" or
   * "Bandwidth düşük — kalite/FPS azalt"). Null when no warning is
   * active. Cleared on share stop.
   */
  screenSharePublisherWarning: ScreenShareLimitationReason | null;

  toggleWatchScreenShare: (userId: string) => void;
  focusScreenShare: (userId: string) => void;
  /** Clear watch state for a streamer who has stopped sharing or disconnected. */
  removeWatchScreenShare: (userId: string) => void;
  /** Called by the receiver-stats hook each cycle. */
  setScreenShareQualityGrade: (publisherId: string, quality: ScreenShareQualityGrade) => void;
  /** Drop a publisher's quality entry (called on Unsubscribe / Disconnect). */
  clearScreenShareQualityGrade: (publisherId: string) => void;
  /** Set the local broadcaster's encoder-limitation warning, or pass null to clear. */
  setScreenSharePublisherWarning: (reason: ScreenShareLimitationReason | null) => void;
};

export const createVoiceScreenShareSlice: StateCreator<
  VoiceStore,
  [],
  [],
  VoiceScreenShareSlice
> = (set, get) => ({
  watchingScreenShares: {},
  screenShareViewers: {},
  screenShareQualityGradeByPublisher: {},
  screenSharePublisherWarning: null,

  toggleWatchScreenShare: (userId: string) => {
    const { watchingScreenShares, _wsSend } = get();
    const isWatching = watchingScreenShares[userId] ?? false;

    if (isWatching) {
      const next = { ...watchingScreenShares };
      delete next[userId];
      set({ watchingScreenShares: next });
      playLeaveSound();
    } else {
      set({ watchingScreenShares: { ...watchingScreenShares, [userId]: true } });
      playJoinSound();
    }

    if (_wsSend) {
      _wsSend("screen_share_watch", {
        streamer_user_id: userId,
        watching: !isWatching,
      });
    }
  },

  removeWatchScreenShare: (userId: string) => {
    const { watchingScreenShares } = get();
    if (!watchingScreenShares[userId]) return;
    const next = { ...watchingScreenShares };
    delete next[userId];
    set({ watchingScreenShares: next });
  },

  setScreenShareQualityGrade: (publisherId, quality) => {
    const cur = get().screenShareQualityGradeByPublisher;
    // Skip the set call when the grade hasn't changed — keeps React from
    // re-rendering every panel on every 10 s tick when nothing meaningful
    // moved. The badge only changes appearance on transitions.
    if (cur[publisherId] === quality) return;
    set({
      screenShareQualityGradeByPublisher: { ...cur, [publisherId]: quality },
    });
  },

  clearScreenShareQualityGrade: (publisherId) => {
    const cur = get().screenShareQualityGradeByPublisher;
    if (!(publisherId in cur)) return;
    const next = { ...cur };
    delete next[publisherId];
    set({ screenShareQualityGradeByPublisher: next });
  },

  setScreenSharePublisherWarning: (reason) => {
    // Idempotent — same warning twice in a row shouldn't re-render the
    // banner. The hook does its own hysteresis on top, but the no-op
    // guard here protects against accidental redundant set calls from
    // future callers.
    if (get().screenSharePublisherWarning === reason) return;
    set({ screenSharePublisherWarning: reason });
  },

  focusScreenShare: (userId: string) => {
    const { watchingScreenShares, _wsSend } = get();
    const watchingIds = Object.keys(watchingScreenShares);

    if (watchingIds.length === 1 && watchingScreenShares[userId]) return;

    if (_wsSend) {
      for (const id of watchingIds) {
        if (id !== userId) {
          _wsSend("screen_share_watch", { streamer_user_id: id, watching: false });
        }
      }
      if (!watchingScreenShares[userId]) {
        _wsSend("screen_share_watch", { streamer_user_id: userId, watching: true });
      }
    }

    set({ watchingScreenShares: { [userId]: true } });
    playLeaveSound();
  },
});
