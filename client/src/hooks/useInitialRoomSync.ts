/**
 * useInitialRoomSync — push the user's voice state into LiveKit on connect
 * and re-push it after every internal SDK reconnect.
 *
 * This is the first thing that runs after the LiveKit connection establishes.
 * Other hooks (useMicSync, useVolumeSync, useTrackSubscriptions) gate on
 * `initialSyncDone.current` so they don't fire BEFORE the initial state has
 * been applied — preventing transient wrong-state writes.
 *
 * What it does on RoomEvent.Connected:
 *   - Mic enabled: PTT mode → off; voice activity → respect isMuted+server mute
 *   - Subscriptions: with autoSubscribe=false, walk every existing remote and
 *     subscribe their mic (if not deafened) + their screen share (if the user
 *     has opted into watching that participant's share).
 *   - Set initialSyncDone.current = true so other hooks can start firing.
 *
 * What it does on RoomEvent.Reconnected:
 *   - SDK-internal reconnect — RemoteParticipant objects may have been
 *     recreated, so volumes and subscriptions need to be reapplied.
 *   - 1000ms delay to let the PeerConnection stabilize before we touch it.
 *   - Re-applies mic enabled, per-participant volumes (mic + screen share),
 *     and subscription state across every remote.
 *
 * Why the reconnect path duplicates volume application instead of relying
 * on useVolumeSync: useVolumeSync's effect only re-runs when its store
 * dependencies change. After a reconnect, those values haven't changed —
 * but the RemoteParticipant *instances* have, so we must re-apply.
 *
 * Was previously ~90 lines inline in VoiceStateManager.tsx.
 */

import { useEffect } from "react";
import {
  ConnectionState,
  RoomEvent,
  Track,
  type LocalParticipant,
  type RemoteTrackPublication,
  type Room,
} from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";
import { resolveUserId } from "../utils/constants";

const RECONNECT_REAPPLY_DELAY_MS = 1000;

export function useInitialRoomSync(
  room: Room,
  localParticipant: LocalParticipant,
  initialSyncDoneRef: React.RefObject<boolean>,
): void {
  useEffect(() => {
    function applyInitialState() {
      const {
        isMuted: currentMuted,
        inputMode: currentMode,
        isServerMuted: srvMuted,
        isDeafened: deaf,
        isServerDeafened: srvDeaf,
        watchingScreenShares: wsShares,
      } = useVoiceStore.getState();

      const shouldEnable =
        currentMode === "push_to_talk" ? false : !currentMuted && !srvMuted;
      const fullyDeaf = deaf || srvDeaf;

      localParticipant.setMicrophoneEnabled(shouldEnable).catch((err: unknown) => {
        console.error("[useInitialRoomSync] Failed to set initial mic state:", err);
      });

      // With autoSubscribe=false nothing is subscribed by default — walk
      // every existing remote and apply our subscription policy.
      room.remoteParticipants.forEach((participant) => {
        const watching = wsShares[resolveUserId(participant.identity)] ?? false;
        participant.trackPublications.forEach((pub) => {
          const rpub = pub as RemoteTrackPublication;
          if (pub.source === Track.Source.Microphone) {
            rpub.setSubscribed(!fullyDeaf);
          } else if (
            pub.source === Track.Source.ScreenShare ||
            pub.source === Track.Source.ScreenShareAudio
          ) {
            rpub.setSubscribed(watching);
          }
        });
      });
    }

    function handleConnected() {
      applyInitialState();
      initialSyncDoneRef.current = true;
    }

    function handleReconnected() {
      const {
        isMuted: currentMuted,
        inputMode: currentMode,
        isServerMuted: srvMuted,
      } = useVoiceStore.getState();
      const shouldEnable =
        currentMode === "push_to_talk" ? false : !currentMuted && !srvMuted;

      // Wait for the PeerConnection to stabilize before re-applying state.
      // RemoteParticipant objects may have been recreated; volumes and
      // subscriptions need to be reapplied from scratch.
      setTimeout(() => {
        localParticipant.setMicrophoneEnabled(shouldEnable).catch((err: unknown) => {
          console.error(
            "[useInitialRoomSync] Failed to restore mic after reconnect:",
            err,
          );
        });

        const {
          userVolumes: vols,
          screenShareVolumes: ssVols,
          masterVolume: master,
          isDeafened: deaf,
          isServerDeafened: srvDeaf,
          watchingScreenShares: wsShares,
        } = useVoiceStore.getState();
        const masterFactor = master / 100;
        const fullyDeaf = deaf || srvDeaf;

        room.remoteParticipants.forEach((participant) => {
          const micVol = vols[participant.identity] ?? 100;
          participant.setVolume(
            fullyDeaf ? 0 : (micVol / 100) * masterFactor,
            Track.Source.Microphone,
          );

          const ssVol = ssVols[participant.identity] ?? 100;
          participant.setVolume(
            fullyDeaf ? 0 : (ssVol / 100) * masterFactor,
            Track.Source.ScreenShareAudio,
          );

          const watching = wsShares[resolveUserId(participant.identity)] ?? false;
          participant.trackPublications.forEach((pub) => {
            if (pub.source === Track.Source.Microphone) {
              (pub as RemoteTrackPublication).setSubscribed(!fullyDeaf);
            } else if (
              pub.source === Track.Source.ScreenShare ||
              pub.source === Track.Source.ScreenShareAudio
            ) {
              (pub as RemoteTrackPublication).setSubscribed(watching);
            }
          });
        });
      }, RECONNECT_REAPPLY_DELAY_MS);
    }

    // Apply right away if already connected when the hook mounts.
    if (room.state === ConnectionState.Connected) {
      handleConnected();
    }

    room.on(RoomEvent.Connected, handleConnected);
    room.on(RoomEvent.Reconnected, handleReconnected);

    return () => {
      room.off(RoomEvent.Connected, handleConnected);
      room.off(RoomEvent.Reconnected, handleReconnected);
      initialSyncDoneRef.current = false;
    };
  }, [room, localParticipant, initialSyncDoneRef]);
}
