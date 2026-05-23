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
 *   - Per-user / master volume + retries          — useVolumeSync
 *   - Screen share lifecycle (3 paths)            — useScreenShareToggle
 *   - Local mic enabled (mute, server mute, PTT)  — useMicSync
 *   - Output device (sinkId) sync                 — useOutputDeviceSync
 *   - Explicit track subscription policy          — useTrackSubscriptions
 *   - Initial-connect + reconnect state push      — useInitialRoomSync
 *   - Verbose debug tracing (off by default)      — useLiveKitDebugTracer
 */

import { useEffect, useRef } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { useVoiceStore } from "../../stores/voiceStore";
import { useAudioProcessor } from "../../hooks/useAudioProcessor";
import { useSpeakingDetection } from "../../hooks/useSpeakingDetection";
import { useRttPolling } from "../../hooks/useRttPolling";
import { useVolumeSync } from "../../hooks/useVolumeSync";
import { useAudioPlayoutTuning } from "../../hooks/useAudioPlayoutTuning";
import { useScreenShareToggle } from "../../hooks/useScreenShareToggle";
import { useMicSync } from "../../hooks/useMicSync";
import { useOutputDeviceSync } from "../../hooks/useOutputDeviceSync";
import { useTrackSubscriptions } from "../../hooks/useTrackSubscriptions";
import { useInitialRoomSync } from "../../hooks/useInitialRoomSync";
import { useLiveKitDebugTracer } from "../../hooks/useLiveKitDebugTracer";

function VoiceStateManager() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();

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

  // Playout-delay hint — give the audio jitter buffer ~100 ms headroom so
  // brief network blips don't trigger the "sped up voice" catchup playback.
  useAudioPlayoutTuning(room);

  // Screen share lifecycle — store↔LiveKit forward sync + external-stop
  // detection (Capacitor native, OS-level "Stop sharing" dialog, SFU drops).
  useScreenShareToggle(room, localParticipant, initialSyncDone);

  // Mic enabled sync — isMuted, isServerMuted, inputMode, and PTT all flow
  // through here to drive localParticipant.setMicrophoneEnabled().
  useMicSync(localParticipant, initialSyncDone);

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

  // Camera publish/unpublish — drives LiveKit from voiceStore.isCameraEnabled.
  // Mirrors the screen-share pattern but stays inline because there's no
  // multi-path complexity (no native handler, no separate audio capture).
  // Errors are toast-free: LiveKit logs its own permission/device failures
  // and the UI button stays in its previous state if publish fails.
  const isCameraEnabled = useVoiceStore((s) => s.isCameraEnabled);
  useEffect(() => {
    if (!initialSyncDone.current) return;
    let cancelled = false;
    (async () => {
      try {
        await localParticipant.setCameraEnabled(isCameraEnabled);
      } catch (err) {
        if (!cancelled) {
          console.error("[VoiceStateManager] camera toggle failed:", err);
          // Roll the store state back so the UI mirrors reality.
          useVoiceStore.getState().setCameraEnabled(!isCameraEnabled);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isCameraEnabled, localParticipant]);

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

  return null;
}

export default VoiceStateManager;
