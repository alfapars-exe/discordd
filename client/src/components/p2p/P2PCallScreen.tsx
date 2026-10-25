/**
 * P2PCallScreen — Main P2P call screen.
 *
 * Rendered when tab.type === "p2p" in PanelView.
 *
 * States: ringing (avatar + cancel), active audio (avatar + duration),
 * active video (remote large + local PiP + controls).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../../api/authSessionEvents";
import { isElectron } from "../../utils/constants";
import { useTranslation } from "react-i18next";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useAuthStore } from "../../stores/authStore";
import Avatar from "../shared/Avatar";
import P2PCallControls from "./P2PCallControls";

// ─── Draggable Local PiP ───

function DraggableLocalVideo({ stream }: { stream: MediaStream }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const videoRef = useCallback(
    (node: HTMLVideoElement | null) => {
      if (node && stream) node.srcObject = stream;
    },
    [stream],
  );

  // Clamp position within parent bounds
  const clamp = useCallback((el: HTMLDivElement) => {
    const parent = el.parentElement;
    if (!parent) return;
    const pr = parent.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    let x = parseInt(el.style.left || "0", 10);
    let y = parseInt(el.style.top || "0", 10);
    x = Math.max(0, Math.min(x, pr.width - er.width));
    y = Math.max(0, Math.min(y, pr.height - er.height));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const el = wrapRef.current;
    if (!el) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    setDragging(true);

    // Switch from right/bottom positioning to left/top for drag
    const parent = el.parentElement;
    if (parent && !el.style.left) {
      const pr = parent.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      el.style.left = `${er.left - pr.left}px`;
      el.style.top = `${er.top - pr.top}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
    }

    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: parseInt(el.style.left || "0", 10),
      origY: parseInt(el.style.top || "0", 10),
    };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const el = wrapRef.current;
    const ds = dragState.current;
    if (!el || !ds) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    el.style.left = `${ds.origX + dx}px`;
    el.style.top = `${ds.origY + dy}px`;
    clamp(el);
  }, [clamp]);

  const onPointerUp = useCallback(() => {
    setDragging(false);
    dragState.current = null;
  }, []);

  return (
    <div
      ref={wrapRef}
      className={`p2p-local-video-wrap${dragging ? " dragging" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <video ref={videoRef} autoPlay playsInline muted style={{ transform: "scaleX(-1)" }} />
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

const subscribeAudioOwner=(changed:()=>void)=>{const a=subscribeAuthOwnerChanges(changed),b=subscribeAuthGenerationChanges(changed);return()=>{a();b();};};
const audioOwnerSnapshot=()=>JSON.stringify(getAuthSessionSnapshot());
function P2PCallScreen() {
  const { t } = useTranslation("common");
  const { t: tv } = useTranslation("voice");
  useSyncExternalStore(subscribeAudioOwner,audioOwnerSnapshot,audioOwnerSnapshot);
  const audioOwner=getAuthSessionSnapshot();
  const activeCall = useP2PCallStore((s) => s.activeCall);
  const localStream = useP2PCallStore((s) => s.localStream);
  const remoteStream = useP2PCallStore((s) => s.remoteStream);
  const callDuration = useP2PCallStore((s) => s.callDuration);
  const isVideoOn = useP2PCallStore((s) => s.isVideoOn);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const screenPending=useP2PCallStore(s=>s.isScreenSharePending),connection=useP2PCallStore(s=>s.peerConnection);
  const audioRequested=useP2PCallStore(s=>s.screenAudioRequested),setAudioRequested=useP2PCallStore(s=>s.setScreenAudioRequested);
  const audioStatus=useP2PCallStore(s=>s.screenAudioStatus),stopAudio=useP2PCallStore(s=>s.stopScreenAudio);
  const peerAudioSupported = useP2PCallStore(s => s.peerScreenAudioSupported);
  const shareVolumes = useVoiceStore(s => s.screenShareVolumes), micVolumes = useVoiceStore(s => s.userVolumes);
  const setShareVolume = useVoiceStore(s => s.setScreenShareVolume), setMicVolume = useVoiceStore(s => s.setUserVolume);
  const peer = activeCall?.caller_id === currentUserId ? activeCall?.receiver_id : activeCall?.caller_id;
  const ownsCall = !!activeCall && !!currentUserId && audioOwner.ownerId===currentUserId && activeCall.status==="active" && [activeCall.caller_id, activeCall.receiver_id].includes(currentUserId);
  const controlsCurrent=()=>{
    const live=useP2PCallStore.getState(),auth=getAuthSessionSnapshot();
    return ownsCall&&auth.ownerId===audioOwner.ownerId&&auth.generation===audioOwner.generation&&useAuthStore.getState().user?.id===currentUserId&&live.activeCall===activeCall&&activeCall?.status==="active"&&live.peerConnection===connection;
  };
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  // Remote audio lives in P2PAudioSink, mounted at the AppLayout level so it
  // survives tab switches (this component unmounts when the user opens any
  // non-p2p tab). Only video is kept here since there's nothing to render
  // off-screen anyway.

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  const isCaller = activeCall ? activeCall.caller_id === currentUserId : false;
  const otherName = activeCall
    ? (isCaller
        ? (activeCall.receiver_display_name ?? activeCall.receiver_username)
        : (activeCall.caller_display_name ?? activeCall.caller_username))
    : "";
  const otherAvatar = activeCall
    ? (isCaller ? activeCall.receiver_avatar : activeCall.caller_avatar)
    : null;

  const isRinging = activeCall?.status === "ringing";
  const isActive = activeCall?.status === "active";
  const isScreenSharing = useP2PCallStore((s) => s.isScreenSharing);

  const hasRemoteVideo = remoteStream?.getVideoTracks().some((tr) => tr.enabled);
  const hasLocalVideo = localStream?.getVideoTracks().some((tr) => tr.enabled);

  return (
    <>
      {!activeCall ? (
        <div className="p2p-call-screen p2p-empty">
          <span className="p2p-status-text">{t("callEnded")}</span>
        </div>
      ) : isRinging ? (
        <div className="p2p-call-screen p2p-ringing">
          <div className="p2p-avatar-large">
            <Avatar
              name={otherName}
              avatarUrl={otherAvatar ?? undefined}
              size={120}
              isCircle
            />
            <div className="p2p-ring-anim" />
          </div>
          <span className="p2p-status-text">
            {t("callingUser", { username: otherName })}
          </span>
          <P2PCallControls minimal />
        </div>
      ) : isActive ? (
        <div className="p2p-call-screen p2p-active">
          <div className="p2p-media-area">
            {hasRemoteVideo ? (
              <video
                ref={remoteVideoRef}
                className="p2p-remote-video"
                muted
                autoPlay
                playsInline
              />
            ) : (
              <div className="p2p-avatar-large">
                <Avatar
                  name={otherName}
                  avatarUrl={otherAvatar ?? undefined}
                  size={120}
                  isCircle
                />
              </div>
            )}

            {/* Local PiP — draggable, independent of remote video state */}
            {hasLocalVideo && isVideoOn && !isScreenSharing && localStream && (
              <DraggableLocalVideo stream={localStream} />
            )}
          </div>

          <div className="p2p-duration">{formatDuration(callDuration)}</div>
          {ownsCall && peer && <div className="p2p-personal-audio">
            <label>{tv("p2pMicrophoneVolume")}<input aria-label={tv("p2pMicrophoneVolume")} type="range" min={0} max={200} value={micVolumes[peer] ?? 100} onChange={event => {if(controlsCurrent())setMicVolume(peer, Number(event.target.value));}} /></label>
            <label>{tv("p2pScreenAudioVolume")}<input aria-label={tv("p2pScreenAudioVolume")} type="range" min={0} max={200} value={shareVolumes[peer] ?? 100} onChange={event => {if(controlsCurrent())setShareVolume(peer, Number(event.target.value));}} /></label>
            {!peerAudioSupported && <p role="status">{tv("p2pScreenAudioPeerUnsupported")}</p>}
            <label><input type="checkbox" checked={audioRequested} disabled={!peerAudioSupported || isScreenSharing || screenPending} onChange={event=>{const live=useP2PCallStore.getState();if(controlsCurrent()&&live.peerScreenAudioSupported&&!live.isScreenSharing&&!live.isScreenSharePending)setAudioRequested(event.target.checked);}} />{tv(isElectron()?"privateScreenAudioWindowsConsent":"privateScreenAudioBrowserConsent")}</label>
            <p role="status">{tv(audioStatus==="starting"?"privateScreenAudioStarting":audioStatus==="shared"?"privateScreenAudioShared":audioStatus==="not_returned"?"privateScreenAudioNotReturned":audioStatus==="unavailable"?"privateScreenAudioUnavailable":audioStatus==="ended"?"p2pScreenAudioEnded":"p2pScreenAudioOff")}</p>
            {(audioStatus==="starting"||audioStatus==="shared") && <button type="button" onClick={()=>{if(controlsCurrent()&&useP2PCallStore.getState().stopScreenAudio===stopAudio)stopAudio();}}>{tv("privateScreenAudioStop")}</button>}
          </div>}
          <P2PCallControls />
        </div>
      ) : null}
    </>
  );
}

export default P2PCallScreen;
