import {useRoomCamera}from "../../hooks/useRoomCamera";
import CameraCaptureStatus from "./CameraCaptureStatus";
import NativePTTStatus from "./NativePTTStatus";
/**
 * VoiceStateManager — orchestrates the bidirectional sync between voiceStore
 * and the LiveKit Room. Renders inside LiveKitRoom. No visual output.
 *
 * The component itself is intentionally small: every concern lives in its
 * own hook. The component's job is to pick the right composition and own
 * the shared `initialSyncDone` ref that gates the dependent hooks.
 *
 * Concerns and their hooks:
 *   - Audio processor (RNNoise / Krisp / VadGate) — useAudioProcessor
 *   - Speaking detection (sidebar green ring)     — useSpeakingDetection
 *   - RTT polling (status indicator)              — useRttPolling
 *   - Per-participant quality (tile signal bars)  — useConnectionQualitySync
 *   - Per-user / master volume + retries          — useVolumeSync
 *   - Screen share lifecycle (3 paths)            — useScreenShareToggle
 *   - Local mic enabled (mute, server mute, PTT)  — useMicSync
 *   - Output device (sinkId) sync                 — useOutputDeviceSync
 *   - Explicit track subscription policy          — useTrackSubscriptions
 *   - Initial-connect + reconnect state push      — useInitialRoomSync
 *   - Verbose debug tracing (off by default)      — useLiveKitDebugTracer
 */

import MicrophoneCaptureStatus from "./MicrophoneCaptureStatus";
import { useEffect, useRef } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { useVoiceStore } from "../../stores/voiceStore";
import { useAudioProcessor } from "../../hooks/useAudioProcessor";
import { useSpeakingDetection } from "../../hooks/useSpeakingDetection";
import { useRttPolling } from "../../hooks/useRttPolling";
import { useConnectionQualitySync } from "../../hooks/useConnectionQualitySync";
import { useVolumeSync } from "../../hooks/useVolumeSync";
import { useAudioPlayoutTuning } from "../../hooks/useAudioPlayoutTuning";
import { useOverlayGoLiveReadiness } from "../../hooks/useOverlayGoLiveReadiness";
import { useScreenShareToggle } from "../../hooks/useScreenShareToggle";
import { useScreenShareStats } from "../../hooks/useScreenShareStats";
import { useScreenShareReceiverStats } from "../../hooks/useScreenShareReceiverStats";
import { useMicSync } from "../../hooks/useMicSync";
import { useOutputDeviceSync } from "../../hooks/useOutputDeviceSync";
import { useTrackSubscriptions } from "../../hooks/useTrackSubscriptions";
import { useInitialRoomSync } from "../../hooks/useInitialRoomSync";
import { useLiveKitDebugTracer } from "../../hooks/useLiveKitDebugTracer";
// Side-effect import: registers window.__hichatAudioDoctor in dev / when the
// `hichat_audio_doctor=1` localStorage flag is set. No runtime cost in prod
// builds when the flag is absent.
import "../../audio/audioDoctor";

function VoiceStateManager() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  useOverlayGoLiveReadiness(room, localParticipant);

  // Skip effects until initial connection sync is done
  const initialSyncDone = useRef(false);

  // Mic track processor (RNNoise / Krisp / VadGate) — extracted hook.
  useAudioProcessor(room, localParticipant, initialSyncDone);

  // Speaking detection — drives sidebar green-ring indicators.
  useSpeakingDetection(room, localParticipant);

  // RTT polling — drives the "Ses Bağlı / NN ms" connection indicator.
  useRttPolling(room);

  // Per-participant network quality — one room-level listener feeds the
  // signal-bar badge on every participant tile (local participant included).
  useConnectionQualitySync(room);

  // Volume sync — per-user, screen share, master, deafen → setVolume() on
  // every remote participant + retry-on-subscribe + retry-on-reconnect.
  useVolumeSync(room);

  // Playout-delay hint — give the audio jitter buffer ~100 ms headroom so
  // brief network blips don't trigger the "sped up voice" catchup playback.
  useAudioPlayoutTuning(room);

  // Screen share lifecycle — store↔LiveKit forward sync + external-stop
  // detection (Capacitor native, OS-level "Stop sharing" dialog, SFU drops).
  useScreenShareToggle(room, localParticipant, initialSyncDone);

  // Publisher-side telemetry — polls RTCRtpSender.getStats() every 10 s
  // while screen-sharing, logs bitrate / fps / qualityLimitationReason to
  // the server so admins can correlate "quality dropped at T" with what
  // the local encoder was reporting. No-op while not sharing.
  useScreenShareStats(localParticipant);

  // Viewer-side telemetry — polls RTCRtpReceiver.getStats() for every
  // subscribed remote screen share, every 10 s. Captures freezes /
  // jitter buffer delay / packet loss / decode drops with publisher
  // attribution so admins can correlate publisher reports with what
  // each viewer actually saw.
  useScreenShareReceiverStats(room);

  // Mic enabled sync — isMuted, isServerMuted, inputMode, and PTT all flow
  // through here to drive localParticipant.setMicrophoneEnabled().
  const ptt=useMicSync(localParticipant, initialSyncDone);

  // Output device sync — apply the chosen sinkId to all LiveKit audio
  // elements, including ones created after future (re)connects.
  useOutputDeviceSync(room);

  // Track subscription policy — explicit per-track subscribe/unsubscribe
  // based on deafen state and which screen shares the user wants to watch.
  useTrackSubscriptions(room);

  // Initial state push to LiveKit on connect, plus full reapply after every
  // SDK-internal reconnect. Sets initialSyncDone.current = true so the gated
  // hooks above can start firing.
  useInitialRoomSync(room, localParticipant, initialSyncDone);

  // [DEBUG] Trace every LiveKit lifecycle event. Flip enabled=true while
  // investigating sporadic disconnects. Default off to keep prod console clean.
  useLiveKitDebugTracer(room, { enabled: false });

  // One admitted raw-camera owner applies live device/quality/FPS changes.
  const isCameraEnabled=useVoiceStore(state=>state.isCameraEnabled);
  const cameraChannel=useVoiceStore(state=>state.currentVoiceChannelId),cameraJoin=useVoiceStore(state=>state._joinGeneration);
  const camera=useRoomCamera(room,isCameraEnabled,true,()=>{const state=useVoiceStore.getState();return state.currentVoiceChannelId===cameraChannel&&state._joinGeneration===cameraJoin;},()=>useVoiceStore.getState().setCameraEnabled(false));

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

  // Expose the live Room on globalThis so the dev `__hichatAudioDoctor()`
  // helper can inspect the local mic pipeline from the DevTools console.
  // Gated by the same dev/flag check inside audioDoctor.ts; this effect
  // is cheap to always run and the global gets cleared on unmount.
  useEffect(() => {
    globalThis.__hichatRoom = room;
    return () => {
      if (globalThis.__hichatRoom === room) {
        globalThis.__hichatRoom = undefined;
      }
    };
  }, [room]);

  return <><MicrophoneCaptureStatus participant={localParticipant} /><NativePTTStatus unavailable={ptt.nativeUnavailable} retry={ptt.retryNative}/><CameraCaptureStatus status={camera} retry={()=>camera.retry(()=>useVoiceStore.getState().setCameraEnabled(true))}/></>;
}

export default VoiceStateManager;
