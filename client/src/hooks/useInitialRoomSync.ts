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
      // Defensive: RoomEvent.Connected fires in a microtask after the SDK
      // flips its state, but by the time this handler runs the room may
      // already have moved to Disconnecting/Disconnected (e.g. user left,
      // auto-rejoin tore down the previous instance). Reading state here
      // catches that race; without it the publish below would throw an
      // "engine not connected within timeout" error that surfaces as noise.
      if (room.state !== ConnectionState.Connected) return;

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
        // Filter the engine-teardown race: between the room.state check
        // above and the SDK reaching the publish path, the PeerConnection
        // can still close. The error is harmless — the next Connected event
        // re-fires this whole handler — so don't surface it as a console
        // error. Anything else is a real failure worth seeing.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("engine not connected")) return;
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
        // The 1s delay above creates a window where the room could leave the
        // Connected state (user navigates away, voice service drops). Skip
        // the whole reapply if we've fallen out of Connected — the next
        // Reconnected event will re-fire this handler if needed.
        if (room.state !== ConnectionState.Connected) return;

        localParticipant.setMicrophoneEnabled(shouldEnable).catch((err: unknown) => {
          // Same engine-teardown race as applyInitialState; treat the
          // "engine not connected" message as expected race fallout and
          // suppress to keep the console signal-to-noise high.
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("engine not connected")) return;
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
