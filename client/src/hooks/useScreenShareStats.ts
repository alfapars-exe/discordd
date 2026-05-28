/**
 * useScreenShareStats — periodic publisher-side telemetry for the
 * active screen share track.
 *
 * Phase 2 of the screen-share quality plan. Phase 1 made encoder /
 * codec / degradation settings observable to the user via the Share
 * Profile toggle, but we still had no way to answer *why* a user's
 * quality dropped: was the encoder CPU-starved, was the network
 * saturated, did the SFU request a layer drop? RTCRtpSender.getStats()
 * answers all three, and we log a snapshot every 10 s so the admin
 * panel can correlate "quality complaint at T" with "qualityLimitation
 * Reason = bandwidth at T".
 *
 * What we capture per sample (all from the publisher's outbound-rtp
 * stats, summed across simulcast layers when present):
 *   - bytesSent           → bitrate (delta_bytes * 8 / interval_s)
 *   - framesSent           → fps     (delta_frames / interval_s)
 *   - framesEncoded        → total encode count (delta)
 *   - qualityLimitationReason   ∈ {none, cpu, bandwidth, other}
 *   - qualityLimitationDurations (cumulative per-reason seconds)
 *   - nackCount / firCount / pliCount  (receiver retransmit pressure)
 *
 * What we deliberately do NOT capture (yet):
 *   - Receiver-side stats. Adding those means walking every remote
 *     participant subscribed to the share and pulling stats off each
 *     RTCRtpReceiver. Doable, but logs would multiply by viewer count
 *     and the admin schema isn't ready yet. Phase 2b.
 *   - Per-layer breakdown. Simulcast layers each show up as a separate
 *     outbound-rtp stat — we collapse them to a single sum to keep the
 *     log payload bounded. If a particular layer is consistently CPU-
 *     starved, that signal is preserved via qualityLimitationReason.
 *
 * Lifecycle: runs only while isStreaming is true. The poll interval
 * cancels itself when isStreaming flips back to false, and we also
 * skip emission when no LocalVideoTrack is attached (transient gap
 * between user toggle and LiveKit publish).
 */

import { useEffect, useRef } from "react";
import {
  Track,
  type LocalParticipant,
  type LocalVideoTrack,
} from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";
import { logToServer } from "../api/clientLog";
import type { ScreenShareLimitationReason } from "../stores/slices/voiceScreenShareSlice";

/**
 * Number of consecutive samples (at STATS_INTERVAL_MS = 10 s) the same
 * encoder limitation has to persist before we promote it to the public
 * `screenSharePublisherWarning` store entry. 2 → 20 s of sustained
 * trouble. Same threshold to clear: 2 clean samples → 20 s of recovery.
 *
 * Stops the UI from flashing a banner on every 10 s spike (which the
 * encoder absolutely WILL produce during a single dropped frame burst)
 * without hiding genuine sustained problems.
 */
const HYSTERESIS_SAMPLES = 2;

/**
 * 10 s gives us ~6 samples/minute per active publisher — fine-grained
 * enough to catch a 30 s congestion event, coarse enough to keep
 * app_logs storage bounded (a single voice channel with 4 sharers
 * produces 24 events/min, ~35K/day worst case).
 */
const STATS_INTERVAL_MS = 10_000;

/**
 * Snapshot of the cumulative counters we delta against. `null` after
 * the first sample (baseline) and after the stream stops.
 */
type Baseline = {
  timestamp: number;
  bytesSent: number;
  framesSent: number;
  framesEncoded: number;
  nackCount: number;
  firCount: number;
  pliCount: number;
};

type OutboundRtpSnapshot = {
  bytesSent: number;
  framesSent: number;
  framesEncoded: number;
  nackCount: number;
  firCount: number;
  pliCount: number;
  qualityLimitationReason: string;
  qualityLimitationDurations: Record<string, number>;
};

/**
 * Walk the RTCStatsReport, summing every outbound-rtp video stat. With
 * simulcast there are 2-3 outbound-rtp entries per share (one per
 * layer); we sum bytesSent and framesSent across all of them so the
 * reported bitrate matches what's leaving the network interface.
 *
 * qualityLimitationReason is taken from the highest-layer entry — the
 * encoder makes the layer-drop decision globally, so any single entry
 * reflects the same reason.
 */
function summariseOutbound(report: RTCStatsReport): OutboundRtpSnapshot {
  const acc: OutboundRtpSnapshot = {
    bytesSent: 0,
    framesSent: 0,
    framesEncoded: 0,
    nackCount: 0,
    firCount: 0,
    pliCount: 0,
    qualityLimitationReason: "none",
    qualityLimitationDurations: {},
  };
  report.forEach((stat) => {
    // The WebRTC type definitions are partial — `kind`, `framesSent`,
    // `qualityLimitationReason` etc. live in spec-but-not-lib.dom.d.ts
    // territory. Cast through unknown so we can read them without
    // littering the file with `as any` every line.
    const s = stat as unknown as {
      type?: string;
      kind?: string;
      bytesSent?: number;
      framesSent?: number;
      framesEncoded?: number;
      nackCount?: number;
      firCount?: number;
      pliCount?: number;
      qualityLimitationReason?: string;
      qualityLimitationDurations?: Record<string, number>;
    };
    if (s.type !== "outbound-rtp" || s.kind !== "video") return;
    acc.bytesSent += s.bytesSent ?? 0;
    acc.framesSent += s.framesSent ?? 0;
    acc.framesEncoded += s.framesEncoded ?? 0;
    acc.nackCount += s.nackCount ?? 0;
    acc.firCount += s.firCount ?? 0;
    acc.pliCount += s.pliCount ?? 0;
    if (s.qualityLimitationReason) {
      acc.qualityLimitationReason = s.qualityLimitationReason;
    }
    if (s.qualityLimitationDurations) {
      acc.qualityLimitationDurations = s.qualityLimitationDurations;
    }
  });
  return acc;
}

/**
 * Map the spec's qualityLimitationReason to the actionable subset we
 * surface to the broadcaster. "other" rolls into null because no clear
 * UX guidance applies; "none" is the no-warning state.
 */
function actionableReason(raw: string): ScreenShareLimitationReason | null {
  if (raw === "cpu") return "cpu";
  if (raw === "bandwidth") return "bandwidth";
  return null;
}

export function useScreenShareStats(localParticipant: LocalParticipant): void {
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const baselineRef = useRef<Baseline | null>(null);

  // Hysteresis trackers — kept in refs because state-bumping them every
  // 10 s would force a re-render on the entire component tree above us
  // even when no UI change is needed.
  const pendingReasonRef = useRef<ScreenShareLimitationReason | null>(null);
  const pendingCountRef = useRef(0);
  const cleanCountRef = useRef(0);

  useEffect(() => {
    if (!isStreaming) {
      // Stream ended — drop the baseline so a future start re-baselines
      // cleanly instead of producing a giant first-delta spike. Also
      // clear any active warning so the banner doesn't stick after the
      // user stops sharing.
      baselineRef.current = null;
      pendingReasonRef.current = null;
      pendingCountRef.current = 0;
      cleanCountRef.current = 0;
      useVoiceStore.getState().setScreenSharePublisherWarning(null);
      return;
    }

    let cancelled = false;

    async function sample(): Promise<void> {
      if (cancelled) return;
      // Resolve the share publication each cycle — the user may have
      // started/stopped/replaced the track since the previous sample.
      const pub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const track = pub?.track as LocalVideoTrack | undefined;
      const sender = track?.sender;
      if (!sender) return;

      let report: RTCStatsReport;
      try {
        report = await sender.getStats();
      } catch (err) {
        // Some browsers throw when the sender is mid-renegotiation.
        // One missed sample isn't worth a banner; just log to console
        // and try again on the next tick.
        console.warn("[screen-share-stats] getStats failed:", err);
        return;
      }
      if (cancelled) return;

      const now = Date.now();
      const snap = summariseOutbound(report);
      const prev = baselineRef.current;

      // First sample after start → just baseline. The delta-vs-cumulative
      // distinction matters: bytesSent is monotonic from publish start, so
      // the first "delta" against zero would report total-since-start as
      // current bitrate, which is misleading and high.
      if (!prev) {
        baselineRef.current = {
          timestamp: now,
          bytesSent: snap.bytesSent,
          framesSent: snap.framesSent,
          framesEncoded: snap.framesEncoded,
          nackCount: snap.nackCount,
          firCount: snap.firCount,
          pliCount: snap.pliCount,
        };
        return;
      }

      const dtSec = (now - prev.timestamp) / 1000;
      if (dtSec <= 0) return; // clock skew or duplicate fire — skip

      const dBytes = Math.max(0, snap.bytesSent - prev.bytesSent);
      const dFrames = Math.max(0, snap.framesSent - prev.framesSent);
      const dEncoded = Math.max(0, snap.framesEncoded - prev.framesEncoded);
      const dNack = Math.max(0, snap.nackCount - prev.nackCount);
      const dFir = Math.max(0, snap.firCount - prev.firCount);
      const dPli = Math.max(0, snap.pliCount - prev.pliCount);

      // Update baseline for the next cycle BEFORE the (potentially slow)
      // log call returns — keeps deltas accurate even under network lag.
      baselineRef.current = {
        timestamp: now,
        bytesSent: snap.bytesSent,
        framesSent: snap.framesSent,
        framesEncoded: snap.framesEncoded,
        nackCount: snap.nackCount,
        firCount: snap.firCount,
        pliCount: snap.pliCount,
      };

      const kbps = Math.round((dBytes * 8) / dtSec / 1000);
      const fps = Math.round(dFrames / dtSec);

      // Hysteresis update — promote a sustained reason to the store
      // warning, or clear it after sustained recovery. Refs so this
      // doesn't churn renders; only the actual store.set call (gated by
      // the no-op guard inside the setter) triggers UI updates.
      const reason = actionableReason(snap.qualityLimitationReason);
      const currentWarning = useVoiceStore.getState().screenSharePublisherWarning;
      if (reason) {
        // Trouble this cycle — reset the clean streak and either start
        // a new pending streak or extend the existing one.
        cleanCountRef.current = 0;
        if (pendingReasonRef.current === reason) {
          pendingCountRef.current += 1;
        } else {
          pendingReasonRef.current = reason;
          pendingCountRef.current = 1;
        }
        if (
          pendingCountRef.current >= HYSTERESIS_SAMPLES &&
          currentWarning !== reason
        ) {
          useVoiceStore.getState().setScreenSharePublisherWarning(reason);
        }
      } else {
        // Clean cycle — reset pending and either count toward a clear
        // or (if already cleared) stay quiet.
        pendingReasonRef.current = null;
        pendingCountRef.current = 0;
        cleanCountRef.current += 1;
        if (cleanCountRef.current >= HYSTERESIS_SAMPLES && currentWarning !== null) {
          useVoiceStore.getState().setScreenSharePublisherWarning(null);
        }
      }

      logToServer("info", "screen_share_stats", {
        intervalSec: Math.round(dtSec),
        kbps,
        fps,
        framesEncoded: dEncoded,
        qualityLimitationReason: snap.qualityLimitationReason,
        // qualityLimitationDurations is a cumulative {none, cpu,
        // bandwidth, other} → seconds map. Stringify so the
        // map[string]string payload shape on the server passes through.
        qualityLimitationDurations: JSON.stringify(snap.qualityLimitationDurations),
        nackDelta: dNack,
        firDelta: dFir,
        pliDelta: dPli,
      });
    }

    // Fire one immediately so we have a baseline within seconds of share
    // start; subsequent cycles produce actual deltas. Then steady-state.
    void sample();
    const handle = setInterval(() => {
      void sample();
    }, STATS_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [isStreaming, localParticipant]);
}
