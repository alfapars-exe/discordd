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

/**
 * A single point in the per-publisher quality history ring buffer. Each
 * sample useScreenShareReceiverStats produces one of these and pushes
 * it into the buffer; everything older than HISTORY_WINDOW_MS is
 * evicted so the array stays bounded.
 */
export type ScreenShareQualityHistoryPoint = {
  /** Epoch ms at the moment the sample was taken. */
  t: number;
  /** Grade computed by computeGrade() in the receiver hook. */
  grade: ScreenShareQualityGrade;
  /** Window kbps from that sample (delta-based). */
  kbps: number;
};

/** Keep about a minute of history so the tooltip can render a short trend. */
export const SCREEN_SHARE_HISTORY_WINDOW_MS = 60_000;

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
  /**
   * publisherUserID -> recent quality samples (last ~60 s). Drives the
   * hover tooltip on ScreenShareQualityBadge so viewers can see the
   * trend at a glance: was the stream always poor, or did it just
   * dip? Capped by SCREEN_SHARE_HISTORY_WINDOW_MS in the writer.
   */
  screenShareQualityHistoryByPublisher: Record<
    string,
    ScreenShareQualityHistoryPoint[]
  >;

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
  /** Append one history point and evict samples older than the window. */
  pushScreenShareQualityHistoryPoint: (
    publisherId: string,
    point: ScreenShareQualityHistoryPoint,
  ) => void;
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
  screenShareQualityHistoryByPublisher: {},

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
    const curHist = get().screenShareQualityHistoryByPublisher;
    const inGrade = publisherId in cur;
    const inHist = publisherId in curHist;
    if (!inGrade && !inHist) return;
    const nextGrade = inGrade ? { ...cur } : cur;
    if (inGrade) delete (nextGrade as Record<string, ScreenShareQualityGrade>)[publisherId];
    const nextHist = inHist ? { ...curHist } : curHist;
    if (inHist) delete (nextHist as Record<string, ScreenShareQualityHistoryPoint[]>)[publisherId];
    set({
      screenShareQualityGradeByPublisher: nextGrade,
      screenShareQualityHistoryByPublisher: nextHist,
    });
  },

  setScreenSharePublisherWarning: (reason) => {
    // Idempotent — same warning twice in a row shouldn't re-render the
    // banner. The hook does its own hysteresis on top, but the no-op
    // guard here protects against accidental redundant set calls from
    // future callers.
    if (get().screenSharePublisherWarning === reason) return;
    set({ screenSharePublisherWarning: reason });
  },

  pushScreenShareQualityHistoryPoint: (publisherId, point) => {
    const cur = get().screenShareQualityHistoryByPublisher;
    const prev = cur[publisherId] ?? [];
    // Single pass: keep entries within the window and append the new one.
    // Iterating once instead of filter+push keeps GC pressure low at the
    // 10 s tick — each push allocates one fresh array, no intermediate.
    const cutoff = point.t - SCREEN_SHARE_HISTORY_WINDOW_MS;
    const next: ScreenShareQualityHistoryPoint[] = [];
    for (let i = 0; i < prev.length; i++) {
      if (prev[i].t >= cutoff) next.push(prev[i]);
    }
    next.push(point);
    set({
      screenShareQualityHistoryByPublisher: {
        ...cur,
        [publisherId]: next,
      },
    });
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
