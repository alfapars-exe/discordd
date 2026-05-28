/**
 * useScreenShareReceiverStats — periodic viewer-side telemetry for
 * every remote screen share subscription.
 *
 * Phase 2b of the screen-share quality plan. Phase 2a (publisher
 * stats) answers "what did MY encoder say?" but a sender-only view
 * misses the part the user actually complains about: "the share I'm
 * WATCHING looks bad". Bandwidth at the publisher can be fine while
 * the network path to one specific viewer drops 30 % of packets — only
 * the viewer's RTCRtpReceiver sees that.
 *
 * What we capture per remote screen share, per sample:
 *   - kbps                  (delta bytesReceived * 8 / interval_s)
 *   - fps                   (delta framesDecoded / interval_s)
 *   - framesDropped         (delta — viewer-side decode/render drops)
 *   - frameWidth / frameHeight  (current simulcast layer the SFU sent)
 *   - freezeCount / freezeMs    (deltas — visible stutters)
 *   - pauseCount / pauseMs      (deltas — adaptiveStream pause/resume)
 *   - jitterBufferDelayMs       (avg = delay / emittedCount, ms)
 *   - packetLossPct             (delta packetsLost / (lost + received))
 *   - nackDelta / firDelta / pliDelta  (viewer-initiated retransmit asks)
 *
 * Attribution: each log row carries `publisherId` and `publisherName`
 * so an admin can join publisher events (Phase 2a) with viewer events
 * (this) on a single share session and answer "did the publisher see
 * the same drop?"
 *
 * Log volume: 1 row per subscribed remote screen-share per 10 s.
 * Worst-case server-wide upper bound: N shares × M viewers × 6/min.
 * At today's scale (~10 active users, ≤2 concurrent shares) this is
 * ~12 rows/min total. We add explicit gating (only when track is
 * actually subscribed AND not paused via adaptiveStream) so dynacast
 * idleness doesn't generate noise.
 *
 * Lifecycle: subscribes to TrackSubscribed/Unsubscribed/Disconnected
 * so the polling set tracks reality without us having to re-scan
 * remoteParticipants every cycle.
 */

import { useEffect, useRef } from "react";
import {
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  type Room,
} from "livekit-client";

import { logToServer } from "../api/clientLog";
import { useVoiceStore } from "../stores/voiceStore";
import { resolveUserId } from "../utils/constants";
import type { ScreenShareQualityGrade } from "../stores/slices/voiceScreenShareSlice";

/**
 * Map this-window stats to a coarse quality grade for the per-panel
 * badge. Thresholds are intentionally generous on the "fair" side so
 * normal congestion blips don't paint everything red.
 *
 *   - poor: any of {packetLoss > 3%, freezeMs > 500, kbps < 200, fps < 5}
 *   - fair: any of {packetLoss > 1%, freezeMs > 100, kbps < 800, fps < 15}
 *   - good: otherwise
 *
 * fps + kbps are window deltas so the grade reacts within one cycle.
 */
function computeGrade(args: {
  packetLossPct: number;
  freezeMs: number;
  kbps: number;
  fps: number;
}): ScreenShareQualityGrade {
  const { packetLossPct, freezeMs, kbps, fps } = args;
  if (packetLossPct > 3 || freezeMs > 500 || kbps < 200 || fps < 5) return "poor";
  if (packetLossPct > 1 || freezeMs > 100 || kbps < 800 || fps < 15) return "fair";
  return "good";
}

const STATS_INTERVAL_MS = 10_000;

type Baseline = {
  timestamp: number;
  bytesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  freezeCount: number;
  totalFreezesDuration: number;
  pauseCount: number;
  totalPausesDuration: number;
  jitterBufferDelay: number;
  jitterBufferEmittedCount: number;
  packetsLost: number;
  packetsReceived: number;
  nackCount: number;
  firCount: number;
  pliCount: number;
};

type InboundRtpSnapshot = Baseline & {
  frameWidth: number;
  frameHeight: number;
};

function summariseInbound(report: RTCStatsReport): InboundRtpSnapshot {
  // Walk every inbound-rtp video stat. With dynacast/adaptiveStream the
  // viewer typically subscribes to exactly one simulcast layer at a
  // time, so there's usually only one entry — but we still sum/last-write
  // defensively in case the SDK ever switches layers mid-poll.
  const acc: InboundRtpSnapshot = {
    timestamp: 0,
    bytesReceived: 0,
    framesDecoded: 0,
    framesDropped: 0,
    freezeCount: 0,
    totalFreezesDuration: 0,
    pauseCount: 0,
    totalPausesDuration: 0,
    jitterBufferDelay: 0,
    jitterBufferEmittedCount: 0,
    packetsLost: 0,
    packetsReceived: 0,
    nackCount: 0,
    firCount: 0,
    pliCount: 0,
    frameWidth: 0,
    frameHeight: 0,
  };
  report.forEach((stat) => {
    const s = stat as unknown as {
      type?: string;
      kind?: string;
      bytesReceived?: number;
      framesDecoded?: number;
      framesDropped?: number;
      freezeCount?: number;
      totalFreezesDuration?: number;
      pauseCount?: number;
      totalPausesDuration?: number;
      jitterBufferDelay?: number;
      jitterBufferEmittedCount?: number;
      packetsLost?: number;
      packetsReceived?: number;
      nackCount?: number;
      firCount?: number;
      pliCount?: number;
      frameWidth?: number;
      frameHeight?: number;
    };
    if (s.type !== "inbound-rtp" || s.kind !== "video") return;
    acc.bytesReceived += s.bytesReceived ?? 0;
    acc.framesDecoded += s.framesDecoded ?? 0;
    acc.framesDropped += s.framesDropped ?? 0;
    acc.freezeCount += s.freezeCount ?? 0;
    acc.totalFreezesDuration += s.totalFreezesDuration ?? 0;
    acc.pauseCount += s.pauseCount ?? 0;
    acc.totalPausesDuration += s.totalPausesDuration ?? 0;
    acc.jitterBufferDelay += s.jitterBufferDelay ?? 0;
    acc.jitterBufferEmittedCount += s.jitterBufferEmittedCount ?? 0;
    acc.packetsLost += s.packetsLost ?? 0;
    acc.packetsReceived += s.packetsReceived ?? 0;
    acc.nackCount += s.nackCount ?? 0;
    acc.firCount += s.firCount ?? 0;
    acc.pliCount += s.pliCount ?? 0;
    // Take the most recent layer's frame size — adaptiveStream may
    // switch layers; the latest tells us what the viewer sees now.
    if (s.frameWidth && s.frameHeight) {
      acc.frameWidth = s.frameWidth;
      acc.frameHeight = s.frameHeight;
    }
  });
  return acc;
}

type TrackKey = string; // `${publisherIdentity}::${trackSid}`

/** Stable key for the baseline map — survives layer switches. */
function keyFor(participant: RemoteParticipant, publication: RemoteTrackPublication): TrackKey {
  return `${participant.identity}::${publication.trackSid}`;
}

/** Pull the underlying RTCRtpReceiver off a LiveKit RemoteVideoTrack. */
function getReceiver(track: RemoteVideoTrack): RTCRtpReceiver | undefined {
  // The SDK exposes `receiver` on the wrapper but doesn't put it in the
  // public type. Same `as any` pattern used in useAudioPlayoutTuning.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (track as any).receiver as RTCRtpReceiver | undefined;
}

export function useScreenShareReceiverStats(room: Room): void {
  // Per-track baselines outlive a single render so cumulative→delta
  // math survives across the 10 s ticks. Keyed by participant + sid so
  // re-subscribes and layer switches don't reset accidentally.
  const baselinesRef = useRef<Map<TrackKey, Baseline>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function sampleOne(
      participant: RemoteParticipant,
      publication: RemoteTrackPublication,
    ): Promise<void> {
      if (cancelled) return;
      if (publication.source !== Track.Source.ScreenShare) return;
      if (!publication.isSubscribed) return;

      const track = publication.track as RemoteVideoTrack | undefined;
      if (!track) return;

      const receiver = getReceiver(track);
      if (!receiver) return;

      let report: RTCStatsReport;
      try {
        report = await receiver.getStats();
      } catch (err) {
        console.warn("[screen-share-receiver-stats] getStats failed:", err);
        return;
      }
      if (cancelled) return;

      const now = Date.now();
      const snap = summariseInbound(report);
      const key = keyFor(participant, publication);
      const prev = baselinesRef.current.get(key);

      // First sample for this (publisher, track) → baseline only. Same
      // reasoning as the publisher hook: cumulative-vs-delta confusion
      // would report the entire publish-lifetime bitrate as "current".
      if (!prev) {
        baselinesRef.current.set(key, {
          timestamp: now,
          bytesReceived: snap.bytesReceived,
          framesDecoded: snap.framesDecoded,
          framesDropped: snap.framesDropped,
          freezeCount: snap.freezeCount,
          totalFreezesDuration: snap.totalFreezesDuration,
          pauseCount: snap.pauseCount,
          totalPausesDuration: snap.totalPausesDuration,
          jitterBufferDelay: snap.jitterBufferDelay,
          jitterBufferEmittedCount: snap.jitterBufferEmittedCount,
          packetsLost: snap.packetsLost,
          packetsReceived: snap.packetsReceived,
          nackCount: snap.nackCount,
          firCount: snap.firCount,
          pliCount: snap.pliCount,
        });
        return;
      }

      const dtSec = (now - prev.timestamp) / 1000;
      if (dtSec <= 0) return;

      const dBytes = Math.max(0, snap.bytesReceived - prev.bytesReceived);
      const dDecoded = Math.max(0, snap.framesDecoded - prev.framesDecoded);
      const dDropped = Math.max(0, snap.framesDropped - prev.framesDropped);
      const dFreezeCount = Math.max(0, snap.freezeCount - prev.freezeCount);
      const dFreezeMs = Math.max(
        0,
        (snap.totalFreezesDuration - prev.totalFreezesDuration) * 1000,
      );
      const dPauseCount = Math.max(0, snap.pauseCount - prev.pauseCount);
      const dPauseMs = Math.max(
        0,
        (snap.totalPausesDuration - prev.totalPausesDuration) * 1000,
      );
      // jitterBufferDelay is cumulative seconds across all emitted frames.
      // The delta over delta-emitted frames gives the per-frame mean delay
      // during this window — that's the number that drives "feels laggy".
      const dJitterSec = Math.max(0, snap.jitterBufferDelay - prev.jitterBufferDelay);
      const dEmitted = Math.max(
        0,
        snap.jitterBufferEmittedCount - prev.jitterBufferEmittedCount,
      );
      const jitterBufferDelayMs = dEmitted > 0 ? Math.round((dJitterSec / dEmitted) * 1000) : 0;
      const dLost = Math.max(0, snap.packetsLost - prev.packetsLost);
      const dRecv = Math.max(0, snap.packetsReceived - prev.packetsReceived);
      const lossDenom = dLost + dRecv;
      const packetLossPct = lossDenom > 0 ? Math.round((dLost / lossDenom) * 1000) / 10 : 0;
      const dNack = Math.max(0, snap.nackCount - prev.nackCount);
      const dFir = Math.max(0, snap.firCount - prev.firCount);
      const dPli = Math.max(0, snap.pliCount - prev.pliCount);

      // Update baseline BEFORE the (potentially slow) log call.
      baselinesRef.current.set(key, {
        timestamp: now,
        bytesReceived: snap.bytesReceived,
        framesDecoded: snap.framesDecoded,
        framesDropped: snap.framesDropped,
        freezeCount: snap.freezeCount,
        totalFreezesDuration: snap.totalFreezesDuration,
        pauseCount: snap.pauseCount,
        totalPausesDuration: snap.totalPausesDuration,
        jitterBufferDelay: snap.jitterBufferDelay,
        jitterBufferEmittedCount: snap.jitterBufferEmittedCount,
        packetsLost: snap.packetsLost,
        packetsReceived: snap.packetsReceived,
        nackCount: snap.nackCount,
        firCount: snap.firCount,
        pliCount: snap.pliCount,
      });

      const kbps = Math.round((dBytes * 8) / dtSec / 1000);
      const fps = Math.round(dDecoded / dtSec);

      const quality = computeGrade({ packetLossPct, freezeMs: dFreezeMs, kbps, fps });
      // Resolve the iOS native sub-participant identity ("<user>_ss") back to
      // the real user ID so the badge on ScreenSharePanel (which uses
      // resolveUserId) reads the same key the panel rendered for.
      const realUserId = resolveUserId(participant.identity);
      useVoiceStore.getState().setScreenShareQualityGrade(realUserId, quality);
      // Append to the rolling history so the tooltip can show "was this
      // always poor, or did it just dip?". Window eviction happens inside
      // the store setter — see SCREEN_SHARE_HISTORY_WINDOW_MS.
      useVoiceStore.getState().pushScreenShareQualityHistoryPoint(realUserId, {
        t: now,
        grade: quality,
        kbps,
      });

      logToServer("info", "screen_share_receiver_stats", {
        publisherId: participant.identity,
        publisherName: participant.name || participant.identity,
        trackSid: publication.trackSid,
        intervalSec: Math.round(dtSec),
        kbps,
        fps,
        frameWidth: snap.frameWidth,
        frameHeight: snap.frameHeight,
        framesDropped: dDropped,
        freezeCount: dFreezeCount,
        freezeMs: Math.round(dFreezeMs),
        pauseCount: dPauseCount,
        pauseMs: Math.round(dPauseMs),
        jitterBufferDelayMs,
        packetLossPct,
        nackDelta: dNack,
        firDelta: dFir,
        pliDelta: dPli,
        quality,
      });
    }

    function sampleAll(): void {
      room.remoteParticipants.forEach((participant) => {
        participant.trackPublications.forEach((pub) => {
          void sampleOne(participant, pub as RemoteTrackPublication);
        });
      });
    }

    function handleUnsubscribed(
      _track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ): void {
      // Drop the baseline so a future re-subscribe starts fresh (avoids a
      // delta spike when the user re-opens a tab that triggered a layer
      // unsubscribe). Also drop the cached quality grade so the panel
      // badge fades back to neutral instead of showing a stale red dot.
      baselinesRef.current.delete(keyFor(participant, publication));
      if (publication.source === Track.Source.ScreenShare) {
        useVoiceStore.getState().clearScreenShareQualityGrade(
          resolveUserId(participant.identity),
        );
      }
    }

    function handleDisconnected(participant: RemoteParticipant): void {
      // Walk our baselines and drop any for this participant. A bit O(N)
      // but the map size is bounded by active share count, which is small.
      const prefix = `${participant.identity}::`;
      for (const key of baselinesRef.current.keys()) {
        if (key.startsWith(prefix)) baselinesRef.current.delete(key);
      }
      useVoiceStore.getState().clearScreenShareQualityGrade(
        resolveUserId(participant.identity),
      );
    }

    room.on(RoomEvent.TrackUnsubscribed, handleUnsubscribed);
    room.on(RoomEvent.ParticipantDisconnected, handleDisconnected);

    sampleAll();
    const handle = setInterval(sampleAll, STATS_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(handle);
      room.off(RoomEvent.TrackUnsubscribed, handleUnsubscribed);
      room.off(RoomEvent.ParticipantDisconnected, handleDisconnected);
      baselinesRef.current.clear();
    };
  }, [room]);
}
