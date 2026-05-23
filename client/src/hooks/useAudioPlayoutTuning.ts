/**
 * useAudioPlayoutTuning — set a small playout-delay hint on every remote
 * audio receiver to absorb network jitter.
 *
 * Rare but annoying symptom this fixes: voice occasionally plays back
 * "sped up" for a second or two. That's WebRTC's jitter buffer catching
 * up after a delivery hiccup — packets queue during a slow moment, then
 * arrive in a burst, and the receiver drains them faster than real time
 * to keep latency low. With the default ~0 ms hint, the buffer runs as
 * shallow as possible and any blip turns into audible playback speedup.
 *
 * `RTCRtpReceiver.playoutDelayHint` (Chrome / Edge / Electron) lets us
 * tell the browser we'd rather trade ~100 ms of latency for a deeper
 * buffer. The browser still adapts dynamically; this is just the lower
 * bound it aims for. 100 ms is below human perceptual threshold for
 * "conversation feels real-time" while being roomy enough to ride out a
 * typical RTT spike.
 *
 * Safari / Firefox quietly ignore the setter — no harm, no benefit.
 * Screen-share audio uses the same path since it's a normal audio track.
 *
 * Wired up by composing into VoiceStateManager next to useVolumeSync.
 */

import { useEffect } from "react";
import {
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
} from "livekit-client";

/**
 * 100 ms playout floor — picked to swallow typical residential network
 * jitter (5-50 ms swings) without making the call feel laggy.
 */
const PLAYOUT_DELAY_HINT_SECONDS = 0.1;

function applyHintToTrack(track: RemoteTrack): void {
  if (track.kind !== Track.Kind.Audio) return;
  // The receiver lives under the SDK's internal wrapper. Both `receiver`
  // and the `playoutDelayHint` setter are guarded — the property is
  // Chrome-only and the field name has been stable since Chrome 90, but
  // we keep the optional chain so non-Chromium engines fall through
  // silently instead of throwing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const receiver = (track as any).receiver as RTCRtpReceiver | undefined;
  if (!receiver) return;
  try {
    // playoutDelayHint is in seconds. Spec: a non-negative hint the UA
    // may use to bound its jitter buffer's minimum playout delay.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (receiver as any).playoutDelayHint = PLAYOUT_DELAY_HINT_SECONDS;
  } catch {
    /* unsupported / read-only on this browser — ignore */
  }
}

export function useAudioPlayoutTuning(room: Room): void {
  useEffect(() => {
    // Apply to anything already subscribed when the hook mounts (the
    // listener below only catches future subscriptions).
    room.remoteParticipants.forEach((p) => {
      p.trackPublications.forEach((pub) => {
        const t = (pub as RemoteTrackPublication).track;
        if (t) applyHintToTrack(t);
      });
    });

    function handleTrackSubscribed(
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      _participant: RemoteParticipant,
    ): void {
      applyHintToTrack(track);
    }

    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    };
  }, [room]);
}
