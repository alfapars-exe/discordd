/**
 * VoiceStateManager — Bidirectional voiceStore <-> LiveKit sync.
 * Renders inside LiveKitRoom. No visual output (returns null).
 *
 * Syncs: mic mute, screen share, PTT, per-user volume, noise reduction,
 * speaking detection, screen share subscriptions, and RTT polling.
 */

import { useEffect, useRef, useCallback } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { RoomEvent, ParticipantEvent, ConnectionState, Track, LocalAudioTrack as LKLocalAudioTrack } from "livekit-client";
import type {
  LocalAudioTrack,
  LocalTrackPublication,
  Participant,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
} from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";
import { useToastStore } from "../../stores/toastStore";
import { usePushToTalk } from "../../hooks/usePushToTalk";
import { RNNoiseProcessor } from "../../audio/RNNoiseProcessor";
import { VadGateProcessor } from "../../audio/VadGateProcessor";
import { useSystemAudioCapture } from "../../hooks/useSystemAudioCapture";
import { isElectron, isCapacitor, resolveUserId } from "../../utils/constants";
import { startNativeScreenShare, stopNativeScreenShare, onNativeScreenShareStopped } from "../../utils/nativePlugins";
import { getScreenShareToken } from "../../api/voice";
import { useServerStore } from "../../stores/serverStore";

/** Both processors expose setMicSensitivity and setInputVolume */
// Krisp returns LiveKit's TrackProcessor<Track.Kind.Audio> at runtime; we
// don't pin its type here so the @livekit/krisp-noise-filter dependency stays
// fully lazy (dynamic import — only fetched when the user opts in).
type AudioProcessor = RNNoiseProcessor | VadGateProcessor | { name: string };

function VoiceStateManager() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const inputMode = useVoiceStore((s) => s.inputMode);
  const isServerMuted = useVoiceStore((s) => s.isServerMuted);
  const isServerDeafened = useVoiceStore((s) => s.isServerDeafened);
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const screenShareVolumes = useVoiceStore((s) => s.screenShareVolumes);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);
  const screenShareAudio = useVoiceStore((s) => s.screenShareAudio);
  const noiseReduction = useVoiceStore((s) => s.noiseReduction);
  const noiseReductionEngine = useVoiceStore((s) => s.noiseReductionEngine);
  const setNoiseReductionEngine = useVoiceStore((s) => s.setNoiseReductionEngine);
  const addToast = useToastStore((s) => s.addToast);
  const micSensitivity = useVoiceStore((s) => s.micSensitivity);
  const inputVolume = useVoiceStore((s) => s.inputVolume);
  const outputDevice = useVoiceStore((s) => s.outputDevice);

  // Skip effects until initial connection sync is done
  const initialSyncDone = useRef(false);

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

  // Process-exclusive audio capture (Electron only).
  // Uses native audio-capture.exe to capture system audio excluding our
  // own Electron process tree — prevents screen share echo.
  const systemAudioCapture = useSystemAudioCapture();
  const systemAudioCaptureRef = useRef(systemAudioCapture);
  systemAudioCaptureRef.current = systemAudioCapture;

  const customAudioPubRef = useRef<LocalTrackPublication | null>(null);

  // Sync isStreaming -> LiveKit screen share.
  // Capacitor (iOS/Android): native plugin via separate LiveKit connection.
  //   iOS: ReplayKit + LiveKit Swift SDK. Android: MediaProjection + LiveKit Android SDK.
  // Electron: video via getDisplayMedia, audio via native WASAPI capture (echo-free).
  // Browser: standard getDisplayMedia with optional audio.
  useEffect(() => {
    if (!initialSyncDone.current) return;

    let cancelled = false;
    const useNativeScreenShare = isCapacitor();

    async function toggleScreenShare() {
      if (cancelled) return;

      if (isStreaming) {
        if (useNativeScreenShare) {
          // Capacitor (iOS/Android): native screen share plugin
          const serverId = useServerStore.getState().activeServerId;
          const channelId = useVoiceStore.getState().currentVoiceChannelId;
          if (!serverId || !channelId) return;

          const response = await getScreenShareToken(serverId, channelId);
          if (cancelled || !response.success || !response.data) {
            console.error("[VoiceStateManager] Failed to get screen share token:", response.error);
            return;
          }

          await startNativeScreenShare(response.data.url, response.data.token);
        } else if (isElectron() && screenShareAudio) {
          // Electron: video only via getDisplayMedia, audio via native capture
          const ssq = useVoiceStore.getState().screenShareQuality;
          const ssRes = ssq === "720p"
            ? { width: 1280, height: 720, frameRate: 30 }
            : { width: 1920, height: 1080, frameRate: 30 };
          await localParticipant.setScreenShareEnabled(true, {
            audio: false,
            resolution: ssRes,
            contentHint: "motion",
          });

          if (cancelled) return;

          const audioTrack = await systemAudioCaptureRef.current.start();

          if (cancelled || !audioTrack) return;

          // Wrap in LiveKit's LocalAudioTrack and publish as ScreenShareAudio
          const lkTrack = new LKLocalAudioTrack(audioTrack, undefined, false);
          const pub = await localParticipant.publishTrack(lkTrack, {
            source: Track.Source.ScreenShareAudio,
          });
          customAudioPubRef.current = pub;
        } else {
          // Browser: standard getDisplayMedia
          const ssq = useVoiceStore.getState().screenShareQuality;
          const ssRes = ssq === "720p"
            ? { width: 1280, height: 720, frameRate: 30 }
            : { width: 1920, height: 1080, frameRate: 30 };
          await localParticipant.setScreenShareEnabled(true, {
            audio: screenShareAudio,
            resolution: ssRes,
            contentHint: "motion",
          });
        }
      } else {
        if (useNativeScreenShare) {
          // Capacitor: stop native screen share
          await stopNativeScreenShare();
        } else {
          if (customAudioPubRef.current) {
            await localParticipant.unpublishTrack(
              customAudioPubRef.current.track!
            );
            customAudioPubRef.current = null;
          }

          systemAudioCaptureRef.current.stop();
          await localParticipant.setScreenShareEnabled(false);
        }
      }
    }

    toggleScreenShare().catch((err: unknown) => {
      if (!cancelled) {
        console.error("[VoiceStateManager] Failed to toggle screen share:", err);
        if (isStreaming) {
          const { _wsSend } = useVoiceStore.getState();
          useVoiceStore.getState().setStreaming(false);
          if (_wsSend) {
            _wsSend("voice_state_update_request", { is_streaming: false });
          }
        }
      }
    });

    return () => { cancelled = true; };
  }, [isStreaming, screenShareAudio, localParticipant]);

  // Capacitor: listen for native screen share stopped (user stops externally)
  useEffect(() => {
    if (!isCapacitor()) return;

    let removeListener: (() => void) | null = null;

    onNativeScreenShareStopped(() => {
      // Sync store state — native screen share was stopped externally.
      // Track is already torn down by the native side at this point, so
      // server notification is safe (no phantom-share window).
      const { isStreaming: currentlyStreaming, _wsSend } = useVoiceStore.getState();
      if (currentlyStreaming) {
        useVoiceStore.getState().setStreaming(false);
        if (_wsSend) {
          _wsSend("voice_state_update_request", { is_streaming: false });
        }
      }
    }).then((cleanup) => {
      removeListener = cleanup;
    });

    return () => {
      removeListener?.();
    };
  }, []);

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

  // RTT polling: try signaling RTT first, fall back to WebRTC stats ICE candidate-pair
  useEffect(() => {
    if (room.state !== ConnectionState.Connected) return;
    let cancelled = false;

    async function pollRtt() {
      if (cancelled) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = (room as any).engine;

        const signalRtt = engine?.client?.rtt as number | undefined;
        if (typeof signalRtt === "number" && signalRtt > 0) {
          useVoiceStore.getState().setRtt(Math.round(signalRtt));
          return;
        }

        const pc = engine?.pcManager?.subscriber?.pc as RTCPeerConnection | undefined;
        if (!pc) return;
        const stats = await pc.getStats();
        if (cancelled) return;

        stats.forEach((report: Record<string, unknown>) => {
          if (
            report.type === "candidate-pair" &&
            report.nominated === true &&
            typeof report.currentRoundTripTime === "number" &&
            report.currentRoundTripTime > 0
          ) {
            useVoiceStore.getState().setRtt(Math.round((report.currentRoundTripTime as number) * 1000));
          }
        });
      } catch {
        // engine/client not ready yet
      }
    }

    pollRtt();
    const interval = setInterval(pollRtt, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [room, room.state]);

  // Speaking detection -> store (for sidebar outside LiveKit context).
  //
  // We listen on TWO channels:
  //  1. ParticipantEvent.IsSpeakingChanged on each participant — driven by
  //     client-side audio-level analysis on the received track. Fires fast,
  //     no server round-trip. This is what gives the green ring real-time
  //     feel.
  //  2. RoomEvent.ActiveSpeakersChanged as a fallback for cases where
  //     IsSpeakingChanged hasn't fired yet (e.g. very first audio frames
  //     or when the client hasn't subscribed to a track).
  //
  // 80ms hold timer on OFF prevents flicker on speech pauses while keeping
  // the indicator feeling tight.
  useEffect(() => {
    const HOLD_MS = 80;
    const setActiveSpeakers = useVoiceStore.getState().setActiveSpeakers;

    const heldSpeakers = new Map<string, boolean>();
    const holdTimers = new Map<string, number>();

    function updateStore() {
      const ids: string[] = [];
      heldSpeakers.forEach((speaking, identity) => {
        if (speaking) ids.push(identity);
      });
      setActiveSpeakers(ids);
    }

    function setSpeakerRaw(identity: string, speaking: boolean) {
      if (speaking) {
        const existing = holdTimers.get(identity);
        if (existing) {
          clearTimeout(existing);
          holdTimers.delete(identity);
        }
        if (!heldSpeakers.get(identity)) {
          heldSpeakers.set(identity, true);
          updateStore();
        }
      } else {
        if (heldSpeakers.get(identity) && !holdTimers.has(identity)) {
          const timerId = window.setTimeout(() => {
            holdTimers.delete(identity);
            heldSpeakers.delete(identity);
            updateStore();
          }, HOLD_MS);
          holdTimers.set(identity, timerId);
        }
      }
    }

    // Per-participant IsSpeakingChanged — the fast path.
    const perParticipantHandlers = new Map<string, (s: boolean) => void>();
    function attachSpeakingListener(p: Participant) {
      if (perParticipantHandlers.has(p.identity)) return;
      const handler = (speaking: boolean) => setSpeakerRaw(p.identity, speaking);
      perParticipantHandlers.set(p.identity, handler);
      p.on(ParticipantEvent.IsSpeakingChanged, handler);
    }
    function detachSpeakingListener(p: Participant) {
      const handler = perParticipantHandlers.get(p.identity);
      if (handler) {
        p.off(ParticipantEvent.IsSpeakingChanged, handler);
        perParticipantHandlers.delete(p.identity);
      }
      // Clear any pending state for the leaving participant
      const timer = holdTimers.get(p.identity);
      if (timer) {
        clearTimeout(timer);
        holdTimers.delete(p.identity);
      }
      if (heldSpeakers.delete(p.identity)) {
        updateStore();
      }
    }

    attachSpeakingListener(localParticipant);
    room.remoteParticipants.forEach(attachSpeakingListener);

    function handleParticipantConnected(p: Participant) {
      attachSpeakingListener(p);
    }
    function handleParticipantDisconnected(p: Participant) {
      detachSpeakingListener(p);
    }
    room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);
    room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);

    // Server-side ActiveSpeakersChanged — fallback / reconciliation.
    function handleActiveSpeakers(speakers: Participant[]) {
      const activeSpeakerIds = new Set(speakers.map((s) => s.identity));
      for (const s of speakers) {
        setSpeakerRaw(s.identity, true);
      }
      heldSpeakers.forEach((_speaking, identity) => {
        if (!activeSpeakerIds.has(identity)) {
          // Don't second-guess the per-participant listener if it just said true
          // — but if the server says they're not in the active set, drop them
          // through the normal HOLD_MS off path.
          setSpeakerRaw(identity, false);
        }
      });
    }
    room.on(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakers);

    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakers);
      room.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
      room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
      perParticipantHandlers.forEach((handler, identity) => {
        const p = identity === localParticipant.identity
          ? localParticipant
          : room.remoteParticipants.get(identity);
        p?.off(ParticipantEvent.IsSpeakingChanged, handler);
      });
      perParticipantHandlers.clear();
      holdTimers.forEach((timerId) => clearTimeout(timerId));
      holdTimers.clear();
      heldSpeakers.clear();
      setActiveSpeakers([]);
    };
  }, [room, localParticipant]);

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

  // Volume sync: per-user + master + deafen -> RemoteParticipant.setVolume()
  // Requires webAudioMix: true for >100% amplification via GainNode.

  // Latest-ref for volume state — avoids re-registering TrackSubscribed listener on every change
  const volumeRef = useRef({ userVolumes, screenShareVolumes, masterVolume, isDeafened, isServerDeafened });
  volumeRef.current = { userVolumes, screenShareVolumes, masterVolume, isDeafened, isServerDeafened };

  // Server deafen overrides local state — all audio is silenced when server deafened
  const effectiveDeafened = isDeafened || isServerDeafened;

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
    []
  );

  // Apply volume when new tracks are subscribed.
  // Retry after 300ms — webAudioMix pipeline may not be ready at subscribe time.
  useEffect(() => {
    function handleTrackSubscribed(
      _track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ): void {
      if (_track.kind !== Track.Kind.Audio) return;

      applyVolumeToParticipant(participant);
      setTimeout(() => applyVolumeToParticipant(participant), 300);
    }

    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);

    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    };
  }, [room, applyVolumeToParticipant]);

  // Apply volume on participant reconnect (new RemoteParticipant object)
  useEffect(() => {
    function handleParticipantConnected(participant: RemoteParticipant) {
      setTimeout(() => applyVolumeToParticipant(participant), 500);
    }

    room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);

    return () => {
      room.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
    };
  }, [room, applyVolumeToParticipant]);

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

  // Audio processor management: NR on -> RNNoise, NR off + sens<100 -> VadGate, else none
  const processorRef = useRef<AudioProcessor | null>(null);
  const noiseReductionRef = useRef(noiseReduction);
  noiseReductionRef.current = noiseReduction;
  const noiseReductionEngineRef = useRef(noiseReductionEngine);
  noiseReductionEngineRef.current = noiseReductionEngine;
  const micSensitivityRef = useRef(micSensitivity);
  micSensitivityRef.current = micSensitivity;
  const inputVolumeRef = useRef(inputVolume);
  inputVolumeRef.current = inputVolume;

  function getDesiredProcessor(
    nr: boolean,
    engine: "rnnoise" | "krisp",
    sens: number,
  ): "krisp" | "rnnoise" | "vadgate" | "none" {
    if (nr) return engine === "krisp" ? "krisp" : "rnnoise";
    if (sens < 100) return "vadgate";
    return "none";
  }

  function getCurrentProcessorType(): "krisp" | "rnnoise" | "vadgate" | "none" {
    const ref = processorRef.current;
    if (!ref) return "none";
    if (ref instanceof RNNoiseProcessor) return "rnnoise";
    if (ref instanceof VadGateProcessor) return "vadgate";
    return "krisp";
  }

  // Switch processor when noiseReduction or micSensitivity changes
  useEffect(() => {
    if (!initialSyncDone.current) return;

    const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
    const audioTrack = pub?.track as LocalAudioTrack | undefined;
    if (!audioTrack) return;

    const desired = getDesiredProcessor(noiseReduction, noiseReductionEngine, micSensitivity);
    const current = getCurrentProcessorType();

    if (desired === current) {
      if (
        processorRef.current &&
        desired !== "none" &&
        desired !== "krisp" &&
        (processorRef.current instanceof RNNoiseProcessor ||
          processorRef.current instanceof VadGateProcessor)
      ) {
        processorRef.current.setMicSensitivity(micSensitivity);
        processorRef.current.setInputVolume(inputVolume);
      }
      return;
    }

    let cancelled = false;

    async function switchProcessor() {
      if (cancelled) return;

      if (processorRef.current) {
        await audioTrack!.stopProcessor();
        processorRef.current = null;
      }

      if (cancelled) return;

      if (desired === "krisp") {
        // Lazy-import @livekit/krisp-noise-filter so the bundle stays small
        // for users who don't enable it. Falls back to RNNoise on failure
        // (most often: the LiveKit Cloud project doesn't have Krisp enabled,
        // which requires a paid plan).
        try {
          const { KrispNoiseFilter, isKrispNoiseFilterSupported } =
            await import("@livekit/krisp-noise-filter");
          if (!isKrispNoiseFilterSupported()) {
            throw new Error("Krisp not supported in this browser");
          }
          if (cancelled) return;
          const processor = KrispNoiseFilter();
          processorRef.current = processor as unknown as AudioProcessor;
          await audioTrack!.setProcessor(processor);
          return;
        } catch (err) {
          console.warn("[VoiceStateManager] Krisp init failed, falling back to RNNoise:", err);
          addToast("warning", "Krisp etkin değil, RNNoise'a geçildi.");
          setNoiseReductionEngine("rnnoise");
          if (cancelled) return;
          const processor = new RNNoiseProcessor(micSensitivity, inputVolume);
          processorRef.current = processor;
          await audioTrack!.setProcessor(processor);
          return;
        }
      }

      if (desired === "rnnoise") {
        const processor = new RNNoiseProcessor(micSensitivity, inputVolume);
        processorRef.current = processor;
        await audioTrack!.setProcessor(processor);
      } else if (desired === "vadgate") {
        const processor = new VadGateProcessor(micSensitivity, inputVolume);
        processorRef.current = processor;
        await audioTrack!.setProcessor(processor);
      }
    }

    switchProcessor().catch((err) => {
      if (!cancelled) {
        console.error("[VoiceStateManager] Failed to switch audio processor:", err);
      }
    });

    return () => { cancelled = true; };
  }, [noiseReduction, noiseReductionEngine, micSensitivity, inputVolume, localParticipant, addToast, setNoiseReductionEngine]);

  // Apply processor when mic track is first published (settings already active on join).
  // The effect above won't catch this since noiseReduction/micSensitivity haven't changed.
  useEffect(() => {
    // Krisp's dynamic import + setProcessor is async. If the user leaves
    // the voice channel before it finishes, we shouldn't write to
    // processorRef on a torn-down track. Guard with a cancelled flag,
    // matching the pattern used by the runtime switch effect.
    let cancelled = false;

    function handleLocalTrackPublished(pub: LocalTrackPublication) {
      if (pub.source !== Track.Source.Microphone) return;
      if (processorRef.current) return; // already applied

      const desired = getDesiredProcessor(
        noiseReductionRef.current,
        noiseReductionEngineRef.current,
        micSensitivityRef.current,
      );
      if (desired === "none") return;

      const audioTrack = pub.track as LocalAudioTrack | undefined;
      if (!audioTrack) return;

      if (desired === "krisp") {
        (async () => {
          try {
            const { KrispNoiseFilter, isKrispNoiseFilterSupported } =
              await import("@livekit/krisp-noise-filter");
            if (cancelled) return;
            if (!isKrispNoiseFilterSupported()) throw new Error("unsupported");
            const processor = KrispNoiseFilter();
            if (cancelled) return;
            processorRef.current = processor as unknown as AudioProcessor;
            await audioTrack.setProcessor(processor);
          } catch (err) {
            if (cancelled) return;
            console.warn("[VoiceStateManager] Krisp init on publish failed, falling back to RNNoise:", err);
            setNoiseReductionEngine("rnnoise");
            const fallback = new RNNoiseProcessor(
              micSensitivityRef.current,
              inputVolumeRef.current,
            );
            if (cancelled) return;
            processorRef.current = fallback;
            await audioTrack.setProcessor(fallback);
          }
        })();
        return;
      }

      let processor: AudioProcessor;
      if (desired === "rnnoise") {
        processor = new RNNoiseProcessor(micSensitivityRef.current, inputVolumeRef.current);
      } else {
        processor = new VadGateProcessor(micSensitivityRef.current, inputVolumeRef.current);
      }

      processorRef.current = processor;
      audioTrack.setProcessor(processor as RNNoiseProcessor | VadGateProcessor)
        .then(() => { /* processor applied */ })
        .catch((err) => console.error("[VoiceStateManager] Failed to apply processor on publish:", err));
    }

    room.on(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
    return () => {
      cancelled = true;
      room.off(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
    };
  }, [room, setNoiseReductionEngine]);

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

  // Sync isStreaming when screen share track is lost (reconnect, SFU drop,
  // user closing the OS-level "Stop sharing" dialog). The track event fires
  // AFTER the track is actually gone, so this is the right place to notify
  // the server too — by the time other clients hear is_streaming=false,
  // their LiveKit subscription is also already torn down. No phantom share.
  useEffect(() => {
    function handleLocalTrackUnpublished(pub: LocalTrackPublication) {
      if (pub.source !== Track.Source.ScreenShare) return;
      const { isStreaming: streaming, _wsSend } = useVoiceStore.getState();
      if (streaming) {
        useVoiceStore.getState().setStreaming(false);
        if (_wsSend) {
          _wsSend("voice_state_update_request", { is_streaming: false });
        }
      }
    }

    room.on(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
    return () => {
      room.off(RoomEvent.LocalTrackUnpublished, handleLocalTrackUnpublished);
    };
  }, [room]);

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
