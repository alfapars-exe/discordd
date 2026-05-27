/**
 * VoiceProvider — owns the persistent LiveKitRoom at AppLayout level.
 *
 * LiveKitRoom lives here so tab switches don't unmount the WebRTC
 * connection. Visual components (VoiceParticipantGrid, ScreenShareView)
 * can mount/unmount freely; the LiveKit context stays alive in the parent.
 *
 * The component is intentionally thin — every domain concern lives in its
 * own hook:
 *   - E2EE setup           — useE2EEKeyProvider
 *   - Auto-rejoin policy   — useVoiceAutoRejoin (provides onDisconnected)
 *   - Publish defaults     — useScreenSharePublishDefaults
 *
 * Render rules:
 *   - LiveKitRoom is ALWAYS mounted; the `connect` prop toggles connection.
 *   - `display:contents` makes the wrapper invisible to flex/grid layout.
 *   - iOS native voice: JS SDK stays mounted (for context) but with
 *     connect=false. The Swift SDK handles the actual connection.
 */

import { useCallback, useMemo } from "react";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import StreamerPipPreview from "./StreamerPipPreview";
import type { AudioCaptureOptions, AudioPreset, RoomOptions } from "livekit-client";

/**
 * Hard-coded high-fidelity Opus encode for the user mic.
 *
 * 384 kbps is the upper bound the channel model already documents
 * ([models/channel.go:86-89](server/models/channel.go:86)) — the Opus
 * codec publishes cleanly at this rate and the ear stops noticing
 * improvements past ~128 kbps, but the user explicitly asked for the
 * maximum. Bandwidth budget per active speaker: ~768 kbps bidirectional
 * stereo, which sits comfortably inside any modern broadband uplink
 * (and well within the self-hosted SFU's per-publisher quota).
 *
 * A follow-up could wire this to the per-channel `bitrate` column
 * already exposed on UpdateChannelRequest — for now the slider in the
 * channel-settings UI persists the value but the publish path uses
 * this constant.
 */
const HIFI_VOICE_PRESET: AudioPreset = { maxBitrate: 384_000 };

import { useVoiceStore } from "../../stores/voiceStore";
import { useToastStore } from "../../stores/toastStore";
import { useTranslation } from "react-i18next";
import { isNativeVoice as checkIsNativeVoice } from "../../utils/nativePlugins";
import { useE2EEKeyProvider } from "../../hooks/useE2EEKeyProvider";
import { useVoiceAutoRejoin } from "../../hooks/useVoiceAutoRejoin";
import { useScreenSharePublishDefaults } from "../../hooks/useScreenSharePublishDefaults";
import VoiceStateManager from "./VoiceStateManager";

type VoiceProviderProps = {
  children: React.ReactNode;
};

function VoiceProvider({ children }: VoiceProviderProps) {
  const { t } = useTranslation("voice");
  const { t: tE2ee } = useTranslation("e2ee");

  const livekitUrl = useVoiceStore((s) => s.livekitUrl);
  const livekitToken = useVoiceStore((s) => s.livekitToken);
  const e2eePassphrase = useVoiceStore((s) => s.e2eePassphrase);
  const inputDevice = useVoiceStore((s) => s.inputDevice);

  const isInVoice = !!livekitUrl && !!livekitToken;

  // iOS: native SDK handles voice connection — don't connect JS SDK.
  // The JS LiveKitRoom stays mounted (for context) but with connect=false.
  const isNativeVoice = checkIsNativeVoice();
  const isConnected = isInVoice && !isNativeVoice;

  const handleE2eeKeyError = useCallback(
    (err: unknown) => {
      console.error("[VoiceProvider] Failed to set E2EE key:", err);
      useToastStore.getState().addToast("error", tE2ee("voiceE2eeError"), 8000);
    },
    [tE2ee],
  );

  const { keyProvider, e2eeWorker } = useE2EEKeyProvider(e2eePassphrase, {
    onError: handleE2eeKeyError,
  });

  const { handleDisconnected } = useVoiceAutoRejoin(isNativeVoice);

  const handleError = useCallback(
    (err: Error) => {
      // "Client initiated" errors are emitted alongside our own disconnect
      // calls — no user-facing toast for those.
      if (err.message?.includes("Client initiated")) return;

      console.error("[VoiceProvider] LiveKit error:", err);
      useToastStore.getState().addToast("error", t("livekitConnectionError"), 8000);
    },
    [t],
  );

  const handleEncryptionError = useCallback(
    (err: Error) => {
      console.error("[VoiceProvider] E2EE encryption error:", err);
      useToastStore.getState().addToast("error", tE2ee("voiceE2eeError"), 8000);
    },
    [tE2ee],
  );

  // Stable reference — LiveKitRoom uses identity comparison on its props.
  const audioCaptureDefaults: AudioCaptureOptions = useMemo(
    () => ({
      noiseSuppression: true,
      autoGainControl: true,
      echoCancellation: true,
      // Mono capture across the board. Some USB / virtual mics expose two
      // channels with one silent; without this, the silent channel feeds
      // half the playback graph on remotes and shows up as "audio only in
      // one ear". Forcing mono at capture eliminates that whole class of
      // bug regardless of downstream processor (RNNoise, VadGate, none).
      channelCount: 1,
      ...(inputDevice ? { deviceId: inputDevice } : {}),
    }),
    [inputDevice],
  );

  const publishDefaults = useScreenSharePublishDefaults();

  const roomOptions: RoomOptions | undefined = useMemo(() => {
    if (!isConnected) return undefined;

    const base: RoomOptions = {
      audioCaptureDefaults,
      publishDefaults: {
        ...publishDefaults,
        // Top-of-range hi-fi voice (384 kbps Opus). See HIFI_VOICE_PRESET
        // above for the rationale + bandwidth math. Previously this was
        // AudioPresets.musicHighQuality (~64 kbps) which the user found
        // too compressed for music sessions.
        audioPreset: HIFI_VOICE_PRESET,
      },
      webAudioMix: true,
      // adaptiveStream: SFU sends the lower simulcast layer when a
      // subscriber's viewport is small. Without this, full-res is sent
      // regardless of viewer size → bandwidth waste → packet loss.
      adaptiveStream: true,
      // dynacast: pauses video encoding when no subscriber is watching a
      // track. Saves upstream bandwidth when e.g. screen share has 0 viewers.
      dynacast: true,
    };

    if (e2eePassphrase && e2eeWorker) {
      base.e2ee = {
        keyProvider,
        worker: e2eeWorker,
      };
    }

    return base;
  }, [isConnected, audioCaptureDefaults, publishDefaults, e2eePassphrase, keyProvider, e2eeWorker]);

  return (
    <LiveKitRoom
      serverUrl={livekitUrl || "wss://placeholder.invalid"}
      token={livekitToken || ""}
      connect={isConnected}
      audio={false}
      video={false}
      options={roomOptions}
      // Subscriptions are managed explicitly in VoiceStateManager.
      connectOptions={{ autoSubscribe: false }}
      onDisconnected={handleDisconnected}
      onError={handleError}
      onEncryptionError={handleEncryptionError}
      style={{ display: "contents" }}
    >
      {isConnected && !isNativeVoice && <RoomAudioRenderer />}
      {isConnected && !isNativeVoice && <VoiceStateManager />}
      {/* Floating broadcaster-self mini-preview. Lives inside LiveKitRoom
          so it can use useRoomContext / useLocalParticipant; renders only
          while isStreaming is true. Self-gated internally. */}
      {isConnected && !isNativeVoice && <StreamerPipPreview />}
      {children}
    </LiveKitRoom>
  );
}

export default VoiceProvider;
