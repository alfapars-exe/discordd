/**
 * useConnectionQualitySync — keep voiceStore.connectionQuality in sync with
 * LiveKit's per-participant network quality estimate, so each participant
 * tile can show a signal-bar indicator.
 *
 * Why the ROOM-level event and not per-participant subscriptions:
 * RoomEvent.ConnectionQualityChanged fires for every participant in the
 * room *including the local one*, so a single listener covers everyone.
 * Subscribing per participant would mean attaching/detaching listeners on
 * every join and leave — more bookkeeping, more chances to leak one.
 *
 * "unknown" is never stored. LiveKit reports it before the first
 * measurement lands and after a participant goes away; treating it as a
 * renderable level would paint an empty indicator on a perfectly healthy
 * call. Absence of a map entry is the "no data" signal, and the UI renders
 * nothing for it.
 *
 * ParticipantDisconnected drops the entry so a participant who rejoins
 * starts from "no data" rather than inheriting their last-known quality.
 */

import { useEffect } from "react";
import { ConnectionQuality, RoomEvent, type Participant, type Room } from "livekit-client";

import { useVoiceStore, type ConnectionQualityLevel } from "../stores/voiceStore";

/**
 * Narrow LiveKit's enum to the renderable subset. Returns null for
 * Unknown and for any future enum member we don't have a bar count for —
 * both mean "don't draw anything".
 */
function toLevel(quality: unknown): ConnectionQualityLevel | null {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return "excellent";
    case ConnectionQuality.Good:
      return "good";
    case ConnectionQuality.Poor:
      return "poor";
    case ConnectionQuality.Lost:
      return "lost";
    default:
      return null;
  }
}

export function useConnectionQualitySync(room: Room): void {
  useEffect(() => {
    const onQualityChanged = (quality: ConnectionQuality, participant?: Participant) => {
      // The SDK types this participant as required, but the event is also
      // emitted from reconnect paths where it can be missing — guard so a
      // malformed payload can't write an `undefined` key into the map.
      if (!participant?.identity) return;

      const level = toLevel(quality);
      if (level) {
        useVoiceStore.getState().setConnectionQuality(participant.identity, level);
      } else {
        useVoiceStore.getState().clearConnectionQuality(participant.identity);
      }
    };

    const onParticipantDisconnected = (participant?: Participant) => {
      if (!participant?.identity) return;
      useVoiceStore.getState().clearConnectionQuality(participant.identity);
    };

    room.on(RoomEvent.ConnectionQualityChanged, onQualityChanged);
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);

    return () => {
      room.off(RoomEvent.ConnectionQualityChanged, onQualityChanged);
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    };
  }, [room]);
}
