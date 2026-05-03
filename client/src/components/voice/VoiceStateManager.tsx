/**
 * VoiceStateManager — Bidirectional voiceStore <-> LiveKit sync.
 * Renders inside LiveKitRoom. No visual output (returns null).
 *
 * Syncs: mic mute, screen share, PTT, per-user volume, noise reduction,
 * speaking detection, screen share subscriptions, and RTT polling.
 */

import { useEffect, useRef, useCallback } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { RoomEvent, ConnectionState, Track } from "livekit-client";
import type {
  Participant,
  RemoteTrackPublication,
  RemoteParticipant,
} from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";
import { usePushToTalk } from "../../hooks/usePushToTalk";
import { useAudioProcessor } from "../../hooks/useAudioProcessor";
import { useSpeakingDetection } from "../../hooks/useSpeakingDetection";
import { useRttPolling } from "../../hooks/useRttPolling";
import { useVolumeSync } from "../../hooks/useVolumeSync";
import { useScreenShareToggle } from "../../hooks/useScreenShareToggle";
import { resolveUserId } from "../../utils/constants";

function VoiceStateManager() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const isMuted = useVoiceStore((s) => s.isMuted);
  const inputMode = useVoiceStore((s) => s.inputMode);
  const isServerMuted = useVoiceStore((s) => s.isServerMuted);
  const isServerDeafened = useVoiceStore((s) => s.isServerDeafened);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);
  const outputDevice = useVoiceStore((s) => s.outputDevice);

  // Server deafen overrides local — used by the mic-subscription effect.
  const effectiveDeafened = isDeafened || isServerDeafened;

  // Skip effects until initial connection sync is done
  const initialSyncDone = useRef(false);

  // Mic track processor (RNNoise / Krisp / VadGate) — extracted hook.
  useAudioProcessor(room, localParticipant, initialSyncDone);

  // Speaking detection — drives sidebar green-ring indicators.
  useSpeakingDetection(room, localParticipant);

  // RTT polling — drives the "Ses Bağlı / NN ms" connection indicator.
  useRttPolling(room);

  // Volume sync — per-user, screen share, master, deafen → setVolume() on
  // every remote participant + retry-on-subscribe + retry-on-reconnect.
  useVolumeSync(room);

  // Screen share lifecycle — store↔LiveKit forward sync + external-stop
  // detection (Capacitor native, OS-level "Stop sharing" dialog, SFU drops).
  useScreenShareToggle(room, localParticipant, initialSyncDone);

  // PTT: bypass store, toggle mic directly on LiveKit participant
  const setMicEnabled = useCallback(
    (enabled: boolean) => {
      localParticipant.setMicrophoneEnabled(enabled).catch((err: unknown) => {
        console.error("[VoiceStateManager] PTT mic toggle failed:", err);
      });
    },
    [localParticipant]
  );

  usePushToTalk({ setMicEnabled });

  // Sync isMuted + isServerMuted -> LiveKit mic enabled
  // Server mute overrides local state — mic is always off when server muted
  useEffect(() => {
    if (!initialSyncDone.current) return;

    const shouldEnable = !isMuted && !isServerMuted;
    localParticipant.setMicrophoneEnabled(shouldEnable).catch((err: unknown) => {
      console.error("[VoiceStateManager] Failed to toggle microphone:", err);
    });
  }, [isMuted, isServerMuted, localParticipant]);

  // Raise EventEmitter limit — we attach many room listeners here + SDK internals
  useEffect(() => {
    if (typeof room.setMaxListeners === "function") {
      room.setMaxListeners(20);
    }
    return () => {
      if (typeof room.setMaxListeners === "function") {
        room.setMaxListeners(10);
      }
    };
  }, [room]);

  // Initial sync on room connect — apply store state to LiveKit
  useEffect(() => {
    function handleConnected() {
      // PTT: mic starts disabled. Voice activity: respect store isMuted + server mute.
      const { isMuted: currentMuted, inputMode: currentMode, isServerMuted: srvMuted,
              isDeafened: deaf, isServerDeafened: srvDeaf,
              watchingScreenShares: wsShares } = useVoiceStore.getState();
      const shouldEnable = currentMode === "push_to_talk" ? false : (!currentMuted && !srvMuted);
      const fullyDeaf = deaf || srvDeaf;

      localParticipant.setMicrophoneEnabled(shouldEnable).catch((err: unknown) => {
        console.error("[VoiceStateManager] Failed to set initial mic state:", err);
      });

      // With autoSubscribe=false, nothing is subscribed by default. Subscribe
      // existing participants' mic (if not deafened) and any screen shares the
      // user has opted into. Screen share stays unsubscribed by default.
      room.remoteParticipants.forEach((p) => {
        const watching = wsShares[resolveUserId(p.identity)] ?? false;
        p.trackPublications.forEach((pub) => {
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

      initialSyncDone.current = true;
    }

    // Restore mic and volumes after SDK internal reconnect.
    // RoomEvent.Reconnected fires when LiveKit reconnects without our intervention.
    function handleReconnected() {
      const { isMuted: currentMuted, inputMode: currentMode, isServerMuted: srvMuted } = useVoiceStore.getState();
      const shouldEnable = currentMode === "push_to_talk" ? false : (!currentMuted && !srvMuted);

      // Wait for PeerConnection to stabilize before re-enabling mic
      setTimeout(() => {
        localParticipant.setMicrophoneEnabled(shouldEnable).catch((err: unknown) => {
          console.error("[VoiceStateManager] Failed to restore mic after reconnect:", err);
        });

        // Re-apply volumes and screen share subscriptions — RemoteParticipant objects may have been recreated
        const { userVolumes: vols, screenShareVolumes: ssVols, masterVolume: master, isDeafened: deaf, isServerDeafened: srvDeaf, watchingScreenShares: wsShares } =
          useVoiceStore.getState();
        const masterFactor = master / 100;
        const fullyDeaf = deaf || srvDeaf;

        room.remoteParticipants.forEach((participant) => {
          const micVol = vols[participant.identity] ?? 100;
          participant.setVolume(fullyDeaf ? 0 : (micVol / 100) * masterFactor, Track.Source.Microphone);

          const ssVol = ssVols[participant.identity] ?? 100;
          participant.setVolume(fullyDeaf ? 0 : (ssVol / 100) * masterFactor, Track.Source.ScreenShareAudio);

          // Restore subscription state.
          // Mic: follow deafen. Screen share: follow user opt-in.
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
      }, 1000);
    }

    if (room.state === ConnectionState.Connected) {
      handleConnected();
    }

    room.on(RoomEvent.Connected, handleConnected);
    room.on(RoomEvent.Reconnected, handleReconnected);

    return () => {
      room.off(RoomEvent.Connected, handleConnected);
      room.off(RoomEvent.Reconnected, handleReconnected);
      initialSyncDone.current = false;
    };
  }, [room, localParticipant]);

  // Apply output device (sinkId) to all LiveKit audio elements.
  // Runs on every outputDevice change and on (re)connect — switchActiveDevice
  // stores the preference on the Room so new tracks also honor it.
  useEffect(() => {
    if (!outputDevice) return;

    async function applyOutputDevice() {
      try {
        await room.switchActiveDevice("audiooutput", outputDevice);
      } catch (err) {
        console.error("[VoiceStateManager] Failed to switch output device:", err);
      }
    }

    if (room.state === ConnectionState.Connected) {
      applyOutputDevice();
    }

    function handleConnected() {
      applyOutputDevice();
    }
    room.on(RoomEvent.Connected, handleConnected);
    room.on(RoomEvent.Reconnected, handleConnected);

    return () => {
      room.off(RoomEvent.Connected, handleConnected);
      room.off(RoomEvent.Reconnected, handleConnected);
    };
  }, [room, outputDevice]);


  // Sync inputMode changes: PTT -> mic off, voice activity -> restore isMuted
  useEffect(() => {
    if (!initialSyncDone.current) return;

    if (inputMode === "push_to_talk") {
      localParticipant.setMicrophoneEnabled(false).catch((err: unknown) => {
        console.error("[VoiceStateManager] Failed to mute on PTT switch:", err);
      });
    } else {
      const { isMuted: currentMuted, isServerMuted: srvMuted } = useVoiceStore.getState();
      localParticipant.setMicrophoneEnabled(!currentMuted && !srvMuted).catch((err: unknown) => {
        console.error("[VoiceStateManager] Failed to restore mic on VA switch:", err);
      });
    }
  }, [inputMode, localParticipant]);

  // [DEBUG] Trace every LiveKit connection lifecycle event for disconnect investigation.
  // Remove once root cause of sporadic disconnects is identified.
  useEffect(() => {
    function stamp(event: string, extra?: Record<string, unknown>) {
      console.warn(`[LKDebug] ${event}`, {
        timestamp: new Date().toISOString(),
        roomState: room.state,
        sid: room.localParticipant?.sid,
        identity: room.localParticipant?.identity,
        remoteCount: room.remoteParticipants.size,
        ...extra,
      });
    }

    const onConnStateChanged = (state: ConnectionState) => stamp("ConnectionStateChanged", { newState: state });
    const onSignalConnected = () => stamp("SignalConnected");
    const onReconnecting = () => stamp("Reconnecting");
    const onReconnected = () => stamp("Reconnected");
    const onDisconnected = (reason?: unknown) => stamp("Disconnected (room event)", { reason });
    const onMediaDevicesError = (err: Error) => stamp("MediaDevicesError", { message: err.message });
    const onConnectionQualityChanged = (quality: unknown, participant?: Participant) => {
      if (participant?.isLocal) stamp("LocalConnectionQualityChanged", { quality });
    };

    room.on(RoomEvent.ConnectionStateChanged, onConnStateChanged);
    room.on(RoomEvent.SignalConnected, onSignalConnected);
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);
    room.on(RoomEvent.ConnectionQualityChanged, onConnectionQualityChanged);

    stamp("Listeners attached");

    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onConnStateChanged);
      room.off(RoomEvent.SignalConnected, onSignalConnected);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
      room.off(RoomEvent.ConnectionQualityChanged, onConnectionQualityChanged);
    };
  }, [room]);


  // Screen share subscription control.
  // autoSubscribe stays true (audio tracks auto-subscribe).
  // Screen share tracks are manually controlled: unsubscribe on publish,
  // subscribe when user clicks in sidebar.
  //
  // Microphone tracks are also controlled: when deafened we refuse the
  // subscription entirely — setting volume=0 has a ~1s window where the
  // audio element plays at its native volume before webAudioMix attaches.

  // Effect A: Explicitly subscribe newly published tracks.
  // With autoSubscribe=false, nothing subscribes unless we say so.
  // Mic follows deafen state; screen share follows user opt-in.
  useEffect(() => {
    function handleTrackPublished(
      publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) {
      if (
        publication.source === Track.Source.ScreenShare ||
        publication.source === Track.Source.ScreenShareAudio
      ) {
        const watching = useVoiceStore.getState().watchingScreenShares[resolveUserId(participant.identity)] ?? false;
        publication.setSubscribed(watching);
      } else if (publication.source === Track.Source.Microphone) {
        const { isDeafened: deaf, isServerDeafened: srvDeaf } = useVoiceStore.getState();
        publication.setSubscribed(!(deaf || srvDeaf));
      }
    }

    room.on(RoomEvent.TrackPublished, handleTrackPublished);
    return () => {
      room.off(RoomEvent.TrackPublished, handleTrackPublished);
    };
  }, [room]);

  // Effect C: Toggle microphone subscriptions when deafen state changes.
  // Also applies on (re)mount — handles the "join already deafened" case
  // where existing participants' mic tracks would otherwise auto-subscribe.
  useEffect(() => {
    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((pub) => {
        if (pub.source === Track.Source.Microphone) {
          (pub as RemoteTrackPublication).setSubscribed(!effectiveDeafened);
        }
      });
    });
  }, [effectiveDeafened, room]);

  // Clear watch state when a remote streamer stops sharing or disconnects.
  // Without this, watchingScreenShares keeps the entry → grid stays in compact
  // mode (icons stuck top-aligned + small) even though no share is visible.
  useEffect(() => {
    function handleRemoteTrackUnpublished(
      publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) {
      if (publication.source !== Track.Source.ScreenShare) return;
      useVoiceStore.getState().removeWatchScreenShare(resolveUserId(participant.identity));
    }

    function handleParticipantDisconnected(participant: RemoteParticipant) {
      useVoiceStore.getState().removeWatchScreenShare(resolveUserId(participant.identity));
    }

    room.on(RoomEvent.TrackUnpublished, handleRemoteTrackUnpublished);
    room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
    return () => {
      room.off(RoomEvent.TrackUnpublished, handleRemoteTrackUnpublished);
      room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
    };
  }, [room]);

  // Effect B: Subscribe/unsubscribe when watchingScreenShares changes.
  useEffect(() => {
    room.remoteParticipants.forEach((participant) => {
      const watching = watchingScreenShares[resolveUserId(participant.identity)] ?? false;

      participant.trackPublications.forEach((pub) => {
        if (
          pub.source === Track.Source.ScreenShare ||
          pub.source === Track.Source.ScreenShareAudio
        ) {
          (pub as RemoteTrackPublication).setSubscribed(watching);
        }
      });
    });
  }, [watchingScreenShares, room]);

  return null;
}

export default VoiceStateManager;
