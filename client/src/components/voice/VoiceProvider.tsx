import AudioPlaybackRecovery from "./AudioPlaybackRecovery";
import {getAuthSessionSnapshot}from "../../api/authSessionEvents";
import {useAuthorizedRoomVideos,manualNativeVideo}from "../../video/useAuthorizedRoomVideos";
import {isPresentedVideoContext,subscribeVideoPresentation}from "../../video/videoPresentation";
import {resolveUserId}from "../../utils/constants";
/**
 * VoiceProvider — owns the LiveKitRoom for the active voice session.
 *
 * Visual components (VoiceParticipantGrid, ScreenShareView) can mount/unmount
 * freely while voice is active; the LiveKit context stays alive in the
 * parent. Tab switches inside the app don't unmount this provider as long as
 * `isInVoice` stays true.
 *
 * The component is intentionally thin — every domain concern lives in its
 * own hook:
 *   - E2EE setup           — useE2EEKeyProvider
 *   - Auto-rejoin policy   — useVoiceAutoRejoin (provides onDisconnected)
 *   - Publish defaults     — useScreenSharePublishDefaults
 *
 * Render rules:
 *   - LiveKitRoom is mounted ONLY while `isInVoice` is true. Outside of a
 *     voice session the provider renders `children` directly so there's no
 *     spurious Room instance. Previously LiveKitRoom was kept mounted with
 *     `connect={false}` and only the prop toggled to true on join — that
 *     `false→true` transition makes `@livekit/components-react` allocate a
 *     second Room (see useVoiceAutoRejoin.ts:24-28 for the prior diagnosis),
 *     producing duplicate SDK logs and a pair of "Client initiated
 *     disconnect" errors before the real connection settled.
 *   - `display:contents` makes the wrapper invisible to flex/grid layout.
 *   - iOS native voice: LiveKitRoom is still mounted while in voice (for
 *     useRoomContext consumers) but with `connect=false`. The Swift SDK
 *     drives the real connection.
 */

import { useCallback, useEffect, useMemo } from "react";
import { LiveKitRoom, RoomAudioRenderer, RoomContext } from "@livekit/components-react";
import StreamerPipPreview from "./StreamerPipPreview";
import { Track, type AudioCaptureOptions, type AudioPreset, type RoomOptions } from "livekit-client";

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
import { micCaptureFor, micPublishFor } from "../../audio/micProfile";
import { microphoneSettings } from "../../audio/microphoneSettings";
import { useChannelStore } from "../../stores/channelStore";
import VoiceRecoveryStatus from "./VoiceRecoveryStatus";
import { useTranslation } from "react-i18next";
import { isNativeVoice as checkIsNativeVoice } from "../../utils/nativePlugins";
import { useEncryptedRoomAdmission } from "../../hooks/useEncryptedRoomAdmission";
import { useE2EEKeyProvider } from "../../hooks/useE2EEKeyProvider";
import { useVoiceAutoRejoin } from "../../hooks/useVoiceAutoRejoin";
import VoiceStateManager from "./VoiceStateManager";

type VoiceProviderProps = {
  children: React.ReactNode;
};

function VoiceProvider({ children }: VoiceProviderProps) {
  const { t } = useTranslation("voice");

  const livekitUrl = useVoiceStore((s) => s.livekitUrl);
  const livekitToken = useVoiceStore((s) => s.livekitToken);
  const e2eePassphrase = useVoiceStore((s) => s.e2eePassphrase);
  const inputDevice = useVoiceStore((s) => s.inputDevice);
  const keyIndex = useVoiceStore((s) => s.e2eeKeyIndex);
  const keyEpoch = useVoiceStore((s) => s.e2eeKeyEpoch);
  const keyContext = useVoiceStore((s) => s.e2eeKeyContext);
  const videoJoinGeneration=useVoiceStore(state=>state._joinGeneration);
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

  const recovery = useVoiceAutoRejoin(isNativeVoice);
  const { handleDisconnected, handleFailure: handleE2eeKeyError,
    handleConnectionError: handleError, markReady } = recovery;
  const encryption = useE2EEKeyProvider(e2eePassphrase, {
    onError: handleE2eeKeyError, enabled: isConnected && !recovery.suspended,
    restartId: recovery.restartId,
    scope: JSON.stringify([currentVoiceChannelId, livekitUrl]), keyIndex, keyEpoch, keyContext,
  });
  const { keyProvider, e2eeWorker } = encryption;

  // Capture + publish profile for the mic (Konuşma / Müzik). These feed the
  // room-level defaults, which is what the FIRST mic publish uses — the one
  // useInitialRoomSync makes at connect time, with no per-publish options.
  // Mid-session profile changes are handled separately by useMicSync, which
  // republishes the track with explicit options (room-level defaults are
  // captured at connect() and never re-applied).
  //
  // Speech profile: mono capture with AEC/AGC on, Opus DTX + RED on.
  // Browser NS follows the selected engine and is off for software denoisers.
  // Mono matters beyond the profile — some USB / virtual mics expose two
  // channels with one silent, and without channelCount:1 that silent channel
  // feeds half the playback graph on remotes ("audio only in one ear").
  // Music profile inverts all of it; see audio/micProfile.ts.
  const micProfile = useVoiceStore((s) => s.micProfile);
  const noiseReduction = useVoiceStore((s) => s.noiseReduction);
  const noiseReductionEngine = useVoiceStore((s) => s.noiseReductionEngine);

  // Stable reference — LiveKitRoom uses identity comparison on its props.
  const audioCaptureDefaults: AudioCaptureOptions = useMemo(
    () => micCaptureFor({ ...microphoneSettings(useVoiceStore.getState()), micProfile, inputDevice, noiseReduction, noiseReductionEngine }),
    [micProfile, inputDevice, noiseReduction, noiseReductionEngine],
  );

  // dtx / red / forceStereo, explicit rather than inherited from the SDK's
  // implicit mono defaults. Stating them documents the speech path next to
  // the contrasting screen-share audio profile and makes it assertable.
  // The music profile also carries its own audioPreset, which deliberately
  // overrides the per-channel voice bitrate below.
  const micPublishDefaults = useMemo(() => micPublishFor(micProfile), [micProfile]);

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
        // Spread last: the music profile's own 256 kbps preset must win over
        // the per-channel voice bitrate, and the speech profile omits
        // audioPreset entirely so voiceAudioPreset survives.
        ...micPublishDefaults,
      },
      webAudioMix: true,
      // adaptiveStream: SFU sends the lower simulcast layer when a
      // subscriber's viewport is small. Without this, full-res is sent
      // regardless of viewer size → bandwidth waste → packet loss.
      adaptiveStream: !manualNativeVideo(),
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
  }, [
    isConnected,
    audioCaptureDefaults,
    voiceAudioPreset,
    micPublishDefaults,
    e2eePassphrase,
    keyProvider,
    e2eeWorker,
  ]);

  const allowRestore = useCallback((source: Track.Source) => {
    const current = useVoiceStore.getState();
    // The remounted controller owns reopening; an old async disposal may still be pending.
    if (source === Track.Source.Microphone) return false;
    if (source === Track.Source.Camera) return current.isCameraEnabled;
    if (source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio) return current.isStreaming;
    return false;
  }, []);
  const admission = useEncryptedRoomAdmission({ enabled: isConnected && !recovery.suspended, token: livekitToken ?? "", scope: encryption.ownerScope,
    keyScope: encryption.keyScope, keyReady: encryption.keyReady, keyError: encryption.keyError,
    keyProvider, worker: e2eeWorker, roomOptions: roomOptions ?? {}, onError: handleE2eeKeyError, allowRestore });
  useEffect(() => { markReady(admission.publishReady); }, [admission.publishReady, markReady]);
  const videoAuth=getAuthSessionSnapshot();
  const videoIdentity=useMemo(()=>({room:admission.room,nonce:crypto.randomUUID()}),[admission.room]);
  const videoLabel=useChannelStore(state=>state.categories.flatMap(category=>category.channels).find(channel=>channel.id===currentVoiceChannelId)?.name)??`${t("voiceConnected")} · ${currentVoiceChannelId??""}`;
  useAuthorizedRoomVideos({room:admission.room,nonce:videoIdentity.nonce,owner:"guild",label:videoLabel,keyContext:keyContext??"",keyEpoch:keyEpoch??0,admitted:admission.publishReady,
    current:()=>{const state=useVoiceStore.getState(),auth=getAuthSessionSnapshot();return !!currentVoiceChannelId&&state.currentVoiceChannelId===currentVoiceChannelId&&state._joinGeneration===videoJoinGeneration
      &&state.livekitToken===livekitToken&&state.livekitUrl===livekitUrl&&state.e2eeKeyContext===keyContext&&state.e2eeKeyEpoch===keyEpoch&&state.e2eeKeyIndex===keyIndex&&state.e2eePassphrase===e2eePassphrase
      &&auth.ownerId===videoAuth.ownerId&&auth.generation===videoAuth.generation;},
    authorized:(participant,publication)=>publication.source===Track.Source.Camera||!!useVoiceStore.getState().watchingScreenShares[resolveUserId(participant.identity)],
    subscribe:changed=>{const a=useVoiceStore.subscribe(changed),b=subscribeVideoPresentation(changed);return()=>{a();b()}},presented:()=>isPresentedVideoContext(currentVoiceChannelId??"","guild")});
  if (!isInVoice) return <>{children}</>;
  return (
    <RoomContext.Provider value={recovery.suspended ? undefined : admission.room ?? undefined}>
    {(isNativeVoice || (!recovery.suspended && admission.room)) && <LiveKitRoom
      serverUrl={livekitUrl || "wss://placeholder.invalid"}
      token={livekitToken || ""}
      room={isNativeVoice ? undefined : admission.room ?? undefined}
      connect={isConnected && admission.connect}
      audio={false}
      video={false}
      screen={false}
      options={isNativeVoice ? roomOptions : undefined}
      // Subscriptions are managed explicitly in VoiceStateManager.
      connectOptions={{ autoSubscribe: false }}
      onDisconnected={handleDisconnected}
      onError={handleError}
      // E2EE errors are owned by the participant-aware admission listener.
      // The SDK React callback discards participant identity and would turn
      // a remote decode failure into a global recovery of this healthy room.
      style={{ display: "contents" }}
    >
      {isConnected && admission.publishReady && <RoomAudioRenderer />}
      {!isNativeVoice && isConnected && admission.publishReady && admission.room && <AudioPlaybackRecovery room={admission.room} />}
      {isConnected && admission.publishReady && <VoiceStateManager />}
      {/* Floating broadcaster-self mini-preview. Lives inside LiveKitRoom
          so it can use useRoomContext / useLocalParticipant; renders only
          while isStreaming is true. Self-gated internally. */}
      {isConnected && admission.publishReady && <StreamerPipPreview />}
      {isNativeVoice && children}
    </LiveKitRoom>}
    <VoiceRecoveryStatus />
    {!isNativeVoice && children}
    </RoomContext.Provider>
  );
}

export default VoiceProvider;
