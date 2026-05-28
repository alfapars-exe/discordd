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
 * Default Opus bitrate when the active voice channel can't be resolved
 * from the channel store (cross-server view, store not yet hydrated,
 * channel record missing a value). 384 kbps matches the system-wide
 * default in [channel_service.go](server/services/channel_service.go)
 * and the historical hard-coded value — picking it as the fallback
 * keeps the audible experience identical for anyone who hasn't moved
 * the per-channel slider.
 */
const DEFAULT_VOICE_BITRATE = 384_000;

import { useVoiceStore } from "../../stores/voiceStore";
import { useChannelStore } from "../../stores/channelStore";
import { useToastStore } from "../../stores/toastStore";
import { useTranslation } from "react-i18next";
import { isNativeVoice as checkIsNativeVoice } from "../../utils/nativePlugins";
import { useE2EEKeyProvider } from "../../hooks/useE2EEKeyProvider";
import { useVoiceAutoRejoin } from "../../hooks/useVoiceAutoRejoin";
import { logToServer } from "../../api/clientLog";
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
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);

  // Per-channel Opus bitrate (Track T1). Resolved from the channel store
  // at the moment LiveKit captures publishDefaults — LiveKit doesn't
  // re-publish on later option changes, so subsequent slider edits only
  // take effect on the next reconnect (Discord matches this behavior).
  //
  // The selector returns DEFAULT_VOICE_BITRATE when the channel isn't in
  // the store. This covers two cases that would otherwise flap the value:
  //   1. The user switched server view while staying in voice — the
  //      voice channel's parent server is no longer the active one.
  //   2. The channel record is hydrated but bitrate is 0 / nullish.
  // Both situations preserve the pre-existing 384 kbps behavior.
  const voiceBitrate = useChannelStore((s) => {
    if (!currentVoiceChannelId) return DEFAULT_VOICE_BITRATE;
    for (const group of s.categories) {
      const ch = group.channels.find((c) => c.id === currentVoiceChannelId);
      if (ch) return ch.bitrate || DEFAULT_VOICE_BITRATE;
    }
    return DEFAULT_VOICE_BITRATE;
  });

  const isInVoice = !!livekitUrl && !!livekitToken;

  // iOS: native SDK handles voice connection — don't connect JS SDK.
  // The JS LiveKitRoom stays mounted (for context) but with connect=false.
  const isNativeVoice = checkIsNativeVoice();
  const isConnected = isInVoice && !isNativeVoice;

  const handleE2eeKeyError = useCallback(
    (err: unknown) => {
      console.error("[VoiceProvider] Failed to set E2EE key:", err);
      logToServer("error", "voice_e2ee_key_failed", {
        errorMessage:
          err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        errorName: err instanceof Error ? err.name : typeof err,
        errorStack: err instanceof Error && err.stack ? err.stack.slice(0, 1024) : "",
      });
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
      logToServer("error", "livekit_room_error", {
        errorMessage: err.message?.slice(0, 200) ?? "",
        errorName: err.name,
        errorStack: err.stack ? err.stack.slice(0, 1024) : "",
        hasLivekitUrl: !!livekitUrl,
        isInVoice,
        isNativeVoice,
      });
      useToastStore.getState().addToast("error", t("livekitConnectionError"), 8000);
    },
    [t, livekitUrl, isInVoice, isNativeVoice],
  );

  const handleEncryptionError = useCallback(
    (err: Error) => {
      console.error("[VoiceProvider] E2EE encryption error:", err);
      logToServer("error", "livekit_e2ee_encryption_error", {
        errorMessage: err.message?.slice(0, 200) ?? "",
        errorName: err.name,
        errorStack: err.stack ? err.stack.slice(0, 1024) : "",
      });
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

  // Stable AudioPreset reference — recomputes only when the resolved
  // bitrate changes. LiveKit applies this on first audio publish.
  const voiceAudioPreset: AudioPreset = useMemo(
    () => ({ maxBitrate: voiceBitrate }),
    [voiceBitrate],
  );

  const roomOptions: RoomOptions | undefined = useMemo(() => {
    if (!isConnected) return undefined;

    // Screen-share encoder + simulcast + codec settings are deliberately
    // NOT in publishDefaults — those room-level options are captured at
    // connect() time and never re-applied. Mid-session quality / FPS /
    // mode changes would silently no-op until the user reconnected.
    // Instead useScreenShareToggle passes them as the 3rd arg of
    // setScreenShareEnabled(), so each share start picks up the latest
    // user choice. Only the per-channel Opus audio preset stays here
    // because audio publish happens once at room join and that mid-call
    // reconfiguration isn't expected.
    const base: RoomOptions = {
      audioCaptureDefaults,
      publishDefaults: {
        audioPreset: voiceAudioPreset,
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
  }, [isConnected, audioCaptureDefaults, voiceAudioPreset, e2eePassphrase, keyProvider, e2eeWorker]);

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
