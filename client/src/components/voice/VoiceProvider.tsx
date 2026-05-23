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
import { AudioPresets } from "livekit-client";
import type { AudioCaptureOptions, RoomOptions } from "livekit-client";

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
        // Hi-fi audio (64 kbps stereo Opus) — speech default is 20 kbps mono.
        // Stereo + higher bitrate noticeably cleans up music/game/voice quality
        // for ~3x the bandwidth, well within self-hosted SFU budgets.
        audioPreset: AudioPresets.musicHighQuality,
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
      {children}
    </LiveKitRoom>
  );
}

export default VoiceProvider;
