/**
 * useVolumeSync — apply per-user, screen-share, and master volume settings
 * to LiveKit RemoteParticipants and keep them in sync as state or
 * participants change.
 *
 * What this owns:
 *
 *   1. Effect A: when any volume / deafen state in the store changes, walk
 *      every remote participant and call setVolume() on both their mic and
 *      screen-share-audio sources. Server deafen overrides local — both
 *      sources are silenced when deafened.
 *
 *   2. Effect B: TrackSubscribed listener — apply volume immediately and
 *      again at +300ms. The retry exists because LiveKit's webAudioMix
 *      GainNode (which enables >100% amplification) may not be wired up at
 *      the moment TrackSubscribed fires, so the first call can be a no-op.
 *
 *   3. Effect C: ParticipantConnected listener — apply volume at +500ms.
 *      The new RemoteParticipant exists immediately, but its track
 *      publications haven't arrived yet; we wait for them.
 *
 * The TrackSubscribed/ParticipantConnected listeners read state via a
 * latest-ref (`volumeRef`) so they aren't re-registered on every slider
 * tick — the room is the only re-registration dependency.
 *
 * Was previously ~80 lines inline in VoiceStateManager.tsx.
 */

import { useEffect, useLayoutEffect, useRef, useCallback } from "react";
import {
  RoomEvent,
  Track,
  type Room,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";

const TRACK_SUBSCRIBED_RETRY_MS = 300;
const PARTICIPANT_CONNECTED_DELAY_MS = 500;

export function useVolumeSync(room: Room): void {
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const screenShareVolumes = useVoiceStore((s) => s.screenShareVolumes);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isServerDeafened = useVoiceStore((s) => s.isServerDeafened);

  // Server deafen overrides local — used by callers that need to drive
  // subscription state, but this hook also derives it internally.
  const effectiveDeafened = isDeafened || isServerDeafened;

  // Latest-ref for the listeners that don't re-register on every change.
  // useLayoutEffect (sync, before browser paint) — React 19's
  // react-hooks/refs rule disallows writing .current during render.
  const volumeRef = useRef({
    userVolumes,
    screenShareVolumes,
    masterVolume,
    isDeafened,
    isServerDeafened,
  });
  useLayoutEffect(() => {
    volumeRef.current = {
      userVolumes,
      screenShareVolumes,
      masterVolume,
      isDeafened,
      isServerDeafened,
    };
  });

  // Effect A: react to store changes — push to every existing remote.
  useEffect(() => {
    room.remoteParticipants.forEach((participant) => {
      const masterFactor = masterVolume / 100;

      const micVol = userVolumes[participant.identity] ?? 100;
      const effectiveMic = effectiveDeafened ? 0 : (micVol / 100) * masterFactor;
      participant.setVolume(effectiveMic, Track.Source.Microphone);

      const ssVol = screenShareVolumes[participant.identity] ?? 100;
      const effectiveSS = effectiveDeafened ? 0 : (ssVol / 100) * masterFactor;
      participant.setVolume(effectiveSS, Track.Source.ScreenShareAudio);
    });
  }, [userVolumes, screenShareVolumes, masterVolume, effectiveDeafened, room]);

  // Helper used by the event listeners. Reads from the latest-ref so its
  // identity stays stable across volume changes.
  const applyVolumeToParticipant = useCallback(
    (participant: RemoteParticipant) => {
      const {
        userVolumes: vols,
        screenShareVolumes: ssVols,
        masterVolume: master,
        isDeafened: deaf,
        isServerDeafened: srvDeaf,
      } = volumeRef.current;
      const masterFactor = master / 100;
      const fullyDeaf = deaf || srvDeaf;

      const micVol = vols[participant.identity] ?? 100;
      const effectiveMic = fullyDeaf ? 0 : (micVol / 100) * masterFactor;
      participant.setVolume(effectiveMic, Track.Source.Microphone);

      const ssVol = ssVols[participant.identity] ?? 100;
      const effectiveSS = fullyDeaf ? 0 : (ssVol / 100) * masterFactor;
      participant.setVolume(effectiveSS, Track.Source.ScreenShareAudio);
    },
    [],
  );

  // Effect B: apply volume when new tracks are subscribed.
  // Retry after 300ms — webAudioMix pipeline may not be ready at subscribe time.
  useEffect(() => {
    function handleTrackSubscribed(
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ): void {
      if (track.kind !== Track.Kind.Audio) return;

      applyVolumeToParticipant(participant);
      setTimeout(() => applyVolumeToParticipant(participant), TRACK_SUBSCRIBED_RETRY_MS);
    }

    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    };
  }, [room, applyVolumeToParticipant]);

  // Effect C: apply volume on participant reconnect (new RemoteParticipant
  // object, track publications arrive after a brief window).
  useEffect(() => {
    function handleParticipantConnected(participant: RemoteParticipant) {
      setTimeout(
        () => applyVolumeToParticipant(participant),
        PARTICIPANT_CONNECTED_DELAY_MS,
      );
    }

    room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);
    return () => {
      room.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
    };
  }, [room, applyVolumeToParticipant]);
}
