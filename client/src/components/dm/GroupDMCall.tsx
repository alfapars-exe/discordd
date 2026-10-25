import { useCallback, useMemo } from "react";
import { DisconnectButton, LiveKitRoom, RoomAudioRenderer, TrackToggle } from "@livekit/components-react";
import { Track, type RoomOptions } from "livekit-client";
import type { VoiceTokenResponse } from "../../types/voice";
import { useE2EEKeyProvider } from "../../hooks/useE2EEKeyProvider";
import { useTranslation } from "react-i18next";

export default function GroupDMCall({ credentials, onLeave }: { credentials: VoiceTokenResponse; onLeave: () => void }) {
  const { t } = useTranslation("voice");
  const onEncryptionError = useCallback((error: unknown) => console.error("[group call] E2EE key error", error), []);
  const { keyProvider, e2eeWorker } = useE2EEKeyProvider(credentials.e2ee_passphrase, { onError: onEncryptionError });
  const options = useMemo<RoomOptions | undefined>(() => e2eeWorker ? { e2ee: { keyProvider, worker: e2eeWorker }, adaptiveStream: true, dynacast: true } : undefined, [e2eeWorker, keyProvider]);
  return <section className="group-dm-call" aria-label={t("voiceConnected")}>
    <LiveKitRoom serverUrl={credentials.url} token={credentials.token} connect audio video={false} options={options} onDisconnected={onLeave}>
      <RoomAudioRenderer />
      <div className="group-dm-call-controls">
        <TrackToggle source={Track.Source.Microphone}>{t("microphone")}</TrackToggle>
        <TrackToggle source={Track.Source.Camera}>{t("camera")}</TrackToggle>
        <TrackToggle source={Track.Source.ScreenShare}>{t("screenShare")}</TrackToggle>
        <DisconnectButton onClick={onLeave}>{t("disconnect")}</DisconnectButton>
      </div>
    </LiveKitRoom>
  </section>;
}
