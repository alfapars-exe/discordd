import GroupDMCallCamera from "./GroupDMCallCamera";
import {ownsP2PCapture}from "../../audio/p2pCaptureOwner";
import {useMicrophoneCaptureViewStore,latchPrivateCaptureFailure,clearPrivateCaptureFailure,retirePrivateCaptureFailure}from "../../stores/microphoneCaptureViewStore";
import { useCallback, useMemo, useState, useLayoutEffect, useRef } from "react";
import { DisconnectButton, LiveKitRoom } from "@livekit/components-react";
import { Track, type RoomOptions } from "livekit-client";
import type { VoiceTokenResponse } from "../../types/voice";
import { useE2EEKeyProvider } from "../../hooks/useE2EEKeyProvider";
import { useToastStore } from "../../stores/toastStore";
import { useEncryptedRoomAdmission } from "../../hooks/useEncryptedRoomAdmission";
import GroupDMCallAudio from "./GroupDMCallAudio";
import GroupScreenShareControl from "./GroupScreenShareControl";
import { privateCaptureConflict } from "../../audio/privateCallState";
import { useVoiceStore } from "../../stores/voiceStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { bindGroupCallAudioControl, releaseGroupCallAudioControl, useGroupCallAudioControlStore } from "../../stores/groupCallAudioControlStore";
import { useGroupDMStore } from "../../stores/groupDMStore";
import { getAuthSessionSnapshot } from "../../api/authSessionEvents";
import { useTranslation } from "react-i18next";

export default function GroupDMCall({ credentials, onLeave, callSessionNonce, initialMicrophoneEnabled, isCurrentSession }: { credentials: VoiceTokenResponse; onLeave: () => void; callSessionNonce?:string; initialMicrophoneEnabled?:boolean; isCurrentSession?:()=>boolean }) {
  const { t } = useTranslation("voice");
  const [captureReady, setCaptureReady] = useState(false);
  const [controlNonce] = useState(() => crypto.randomUUID());
  const [controlOwner] = useState(() => getAuthSessionSnapshot());
  const captureLogicalNonce = callSessionNonce ?? controlNonce;
  const captureFailure = useMicrophoneCaptureViewStore(state => state.privateFailure?.nonce === captureLogicalNonce && state.privateFailure.owner === controlOwner.ownerId && state.privateFailure.generation === controlOwner.generation);
  const setCaptureFailure = useCallback((failed: boolean) => { if (failed && controlOwner.ownerId) latchPrivateCaptureFailure(captureLogicalNonce, controlOwner.ownerId, controlOwner.generation); else if (!failed) clearPrivateCaptureFailure(captureLogicalNonce); }, [captureLogicalNonce, controlOwner]);
  const deafened = useVoiceStore(state => state.isDeafened);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(() => initialMicrophoneEnabled ?? !useVoiceStore.getState().isMuted);
  const guildCapture = useVoiceStore(state => !!state.currentVoiceChannelId);
  const privateCapture = useP2PCallStore(state => ownsP2PCapture(state.activeCall));
  const conflict = guildCapture || privateCapture;
  useLayoutEffect(() => {
    const fence = () => { if (privateCaptureConflict()) setMicrophoneEnabled(false); };
    fence();
    const voice = useVoiceStore.subscribe(fence), p2p = useP2PCallStore.subscribe(fence);
    return () => { voice(); p2p(); };
  }, []);
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
    roomOptions: options ?? {}, isCurrentSource: isCurrentSession, onError: onEncryptionError, allowRestore: (source) => source !== Track.Source.Microphone });
  // A fresh media lease belongs to this actual Room and component mount.
  // Old SDK callbacks must not disconnect a boundary-retry replacement.
  const mountedLease=useRef(false),currentRoomLease=useRef(admission.room);
  useLayoutEffect(()=>{mountedLease.current=true;return()=>{mountedLease.current=false}},[]);
  useLayoutEffect(()=>{currentRoomLease.current=admission.room;return()=>{currentRoomLease.current=null}},[admission.room]);
  const room=admission.room;
  const leaveCurrentRoom=()=>{
    const control=useGroupCallAudioControlStore.getState().control;
    if(mountedLease.current&&currentRoomLease.current===room&&control?.nonce===controlNonce&&(!isCurrentSession||isCurrentSession()))onLeave();
  };
  useLayoutEffect(() => {
    const auth = controlOwner;
    if (!auth.ownerId) return;
    bindGroupCallAudioControl({ nonce: controlNonce, callSessionNonce, accountId: auth.ownerId, generation: auth.generation, groupId: credentials.channel_id,
      manualMuted: !microphoneEnabled, effectiveMuted: !microphoneEnabled || deafened || conflict || !admission.publishReady || !captureReady, blocked: conflict,
      toggle: () => { if ((!isCurrentSession||isCurrentSession())&&!privateCaptureConflict()) setMicrophoneEnabled(value => !value); } });
  }, [controlNonce, controlOwner, callSessionNonce, isCurrentSession, credentials.channel_id, microphoneEnabled, deafened, conflict, admission.publishReady, captureReady]);
  useLayoutEffect(() => () => { releaseGroupCallAudioControl(controlNonce); if (!callSessionNonce) retirePrivateCaptureFailure(captureLogicalNonce); }, [controlNonce, callSessionNonce, captureLogicalNonce]);
  if (!admission.room || (!admission.connect && !admission.error)) return <section role={admission.error ? "alert" : "status"}>
    <p>{admission.error ? tE2ee("voiceE2eeError") : t("connecting")}</p><button type="button" onClick={leaveCurrentRoom}>{t("disconnect")}</button>
  </section>;
  return <section className="group-dm-call" aria-label={t("voiceConnected")}>
    <LiveKitRoom room={admission.room ?? undefined} serverUrl={credentials.url} token={credentials.token} connect={admission.connect} audio={false} video={false} screen={false} onDisconnected={leaveCurrentRoom}>
      {Boolean(admission.error) && <p role="alert">{tE2ee("voiceE2eeError")}</p>}
      {!admission.publishReady && !admission.error && <p role="status">{t("connecting")}</p>}
      <div className="group-dm-call-controls">
        {admission.publishReady && <>
          <GroupDMCallAudio room={admission.room} microphoneEnabled={microphoneEnabled} onMicrophoneChange={setMicrophoneEnabled} onCaptureState={setCaptureReady} captureFailure={captureFailure} onCaptureFailure={setCaptureFailure} isCurrentSession={isCurrentSession} conflict={conflict} />
          <GroupScreenShareControl room={admission.room} groupId={credentials.channel_id} keyEpoch={credentials.e2ee_key_epoch} isCurrentSession={isCurrentSession} />
        </>}
        <GroupDMCallCamera room={admission.room} admitted={admission.publishReady} current={isCurrentSession}/>
        <DisconnectButton onClick={leaveCurrentRoom}>{t("disconnect")}</DisconnectButton>
      </div>
    </LiveKitRoom>
  </section>;
}
