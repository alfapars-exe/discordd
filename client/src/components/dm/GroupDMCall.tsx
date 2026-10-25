import { useCallback, useMemo, useState } from "react";
import { DisconnectButton, LiveKitRoom, RoomAudioRenderer, TrackToggle } from "@livekit/components-react";
import { Track, type RoomOptions } from "livekit-client";
import type { VoiceTokenResponse } from "../../types/voice";
import { useE2EEKeyProvider } from "../../hooks/useE2EEKeyProvider";
import { useToastStore } from "../../stores/toastStore";
import { useEncryptedRoomAdmission } from "../../hooks/useEncryptedRoomAdmission";
import { useGroupDMStore } from "../../stores/groupDMStore";
import { getAuthSessionSnapshot } from "../../api/authSessionEvents";
import { useTranslation } from "react-i18next";

export default function GroupDMCall({ credentials, onLeave }: { credentials: VoiceTokenResponse; onLeave: () => void }) {
  const { t } = useTranslation("voice");
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
  const microphoneChanged = useCallback((enabled: boolean, userInitiated: boolean) => { if (userInitiated) setMicrophoneEnabled(enabled); }, []);
  const { t: tE2ee } = useTranslation("e2ee");
  const onEncryptionError = useCallback((error: unknown) => { console.error("[group call] E2EE key error", error); useToastStore.getState().addToast("error", tE2ee("voiceE2eeError")); }, [tE2ee]);
  const encryption = useE2EEKeyProvider(credentials.e2ee_passphrase, { onError: onEncryptionError, enabled: true,
    scope: JSON.stringify([credentials.channel_id, credentials.url]), keyIndex: credentials.e2ee_key_index, keyEpoch: credentials.e2ee_key_epoch, keyContext: credentials.e2ee_key_context });
  const { keyProvider, e2eeWorker } = encryption;
  const currentEpoch = useGroupDMStore((state) => {
    const owner = getAuthSessionSnapshot();
    if (state.ownerId !== owner.ownerId || state.authGeneration !== owner.generation) return null;
    return state.groups.find((group) => group.id === credentials.channel_id)?.key_epoch ?? null;
  });
  const currentMediaEpoch = currentEpoch !== null && currentEpoch === credentials.e2ee_key_epoch;
  const options = useMemo<RoomOptions | undefined>(() => e2eeWorker ? { e2ee: { keyProvider, worker: e2eeWorker }, adaptiveStream: true, dynacast: true } : undefined, [e2eeWorker, keyProvider]);
  const admission = useEncryptedRoomAdmission({ enabled: true, token: credentials.token, scope: encryption.ownerScope, keyScope: encryption.keyScope,
    keyReady: encryption.keyReady && currentMediaEpoch, keyError: encryption.keyError, keyProvider, worker: e2eeWorker,
    roomOptions: options ?? {}, onError: onEncryptionError });
  if (!admission.room || (!admission.connect && !admission.error)) return <section role={admission.error ? "alert" : "status"}>
    <p>{admission.error ? tE2ee("voiceE2eeError") : t("connecting")}</p><button type="button" onClick={onLeave}>{t("disconnect")}</button>
  </section>;
  return <section className="group-dm-call" aria-label={t("voiceConnected")}>
    <LiveKitRoom room={admission.room ?? undefined} serverUrl={credentials.url} token={credentials.token} connect={admission.connect} audio={false} video={false} screen={false} onDisconnected={onLeave}>
      {Boolean(admission.error) && <p role="alert">{tE2ee("voiceE2eeError")}</p>}
      {!admission.publishReady && !admission.error && <p role="status">{t("connecting")}</p>}
      {admission.publishReady && <RoomAudioRenderer />}
      <div className="group-dm-call-controls">
        {admission.publishReady && <>
          <TrackToggle source={Track.Source.Microphone} initialState={microphoneEnabled} onChange={microphoneChanged}>{t("microphone")}</TrackToggle>
          <TrackToggle source={Track.Source.Camera}>{t("camera")}</TrackToggle>
          <TrackToggle source={Track.Source.ScreenShare}>{t("screenShare")}</TrackToggle>
        </>}
        <DisconnectButton onClick={onLeave}>{t("disconnect")}</DisconnectButton>
      </div>
    </LiveKitRoom>
  </section>;
}
