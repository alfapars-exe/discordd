import {bindAuthorizedVideoSources,type AuthorizedVideoSource}from "../video/authorizedVideoSources";
import {isPresentedVideoContext,subscribeVideoPresentation}from "../video/videoPresentation";
import { P2PScreenAudioSession, type P2PScreenAudioStatus } from "../webrtc/p2pScreenAudioSession";
import { isElectron } from "../utils/constants";
import { validateP2PDescription } from "../webrtc/p2pMediaProtocol";
import { getP2PMediaController, registerP2PLocalSource } from "../webrtc/p2pMediaController";
import {P2PCameraSession}from "../webrtc/p2pCamera";
/**
 * p2pCallStore — P2P call state management (signaling + media orchestration).
 *
 * WebRTC P2P flow:
 *   1. Caller initiates → server validates → relays to receiver
 *   2. Receiver accepts → both sides start WebRTC
 *   3. Caller adds tracks → onnegotiationneeded fires → SDP offer/answer
 *   4. ICE candidates relayed via WS through signaling server
 *   5. Media flows P2P (server stays out of the data plane)
 *
 * Single responsibility (post-refactor): coordinate store state + WS
 * actions. Low-level WebRTC primitives live in:
 *   - webrtc/p2pPeerConnection.ts → createPeerConnection, applyDegradationPreference
 *   - webrtc/p2pScreenShare.ts    → startScreenShare, stopScreenShare
 */

import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";
import { create } from "zustand";
import i18n from "../i18n";
import type { P2PCall, P2PCallType, P2PSignalPayload } from "../types";
import {
  applyDegradationPreference,
  createPeerConnection,
  type SendWS,
} from "../webrtc/p2pPeerConnection";
import { startScreenShare, stopScreenShare, type StartScreenShareResult } from "../webrtc/p2pScreenShare";
import { useToastStore } from "./toastStore";
import { useAuthStore } from "./authStore";
import { useVoiceStore } from "./voiceStore";
import { cameraConstraintsFor, cameraErrorKey } from "../utils/cameraCapture";
import { P2PMicrophoneSession } from "../webrtc/p2pMicrophone";

function selectedCameraConstraints() {
  const { cameraQuality, cameraFps, cameraDevice } = useVoiceStore.getState();
  return cameraConstraintsFor(cameraQuality, cameraFps, cameraDevice);
}

// ─── Helpers ───

/** Stop every track on a stream — defensive cleanup. */
function stopAllTracks(stream: MediaStream | null): void {
  if (!stream) return;
  for (const t of stream.getTracks()) t.stop();
}

// ─── Types ───

type P2PCallStore = {
  /** Active call (ringing or active) — null means not in a call */
  activeCall: P2PCall | null;
  /** Incoming call notification — used by IncomingCallOverlay */
  incomingCall: P2PCall | null;
  /** Local media stream (mic + optional camera) */
  localStream: MediaStream | null;
  /** SDP-authorized remote video only. Audio sources have independent leases. */
  remoteStream: MediaStream | null;
  remoteCameraStream:MediaStream|null;
  remoteScreenVideoStream:MediaStream|null;
  remoteMicrophoneStream: MediaStream | null;
  remoteScreenAudioStream: MediaStream | null;
  peerScreenAudioSupported: boolean;
  screenAudioRequested: boolean;
  screenAudioStatus: P2PScreenAudioStatus;
  setScreenAudioRequested: (requested: boolean) => void;
  stopScreenAudio: () => void;
  /** WebRTC peer connection instance */
  peerConnection: RTCPeerConnection | null;

  /** Sender currently carrying the screen-share track (null when not sharing) */
  _screenSender: RTCRtpSender | null;
  /**
   * ICE candidates buffered before remoteDescription is set.
   * Flushed after setRemoteDescription completes.
   */
  _pendingCandidates: RTCIceCandidateInit[];

  microphoneFailure: {call:P2PCall;ownerId:string;generation:number} | null;
  microphoneRetrying: boolean;
  retryMicrophone: (expectedCall:P2PCall,useDefault?:boolean)=>Promise<boolean>;
  isMuted: boolean;
  isVideoOn: boolean;
  isScreenSharing: boolean;
  isScreenSharePending: boolean;

  /** Active call duration in seconds — incremented by timer */
  callDuration: number;
  _durationInterval: ReturnType<typeof setInterval> | null;

  /** Injected WS send callback (DI from useWebSocket) */
  _sendWS: SendWS | null;
  registerSendWS: (fn: SendWS | null) => void;

  // ─── Actions ───
  initiateCall: (receiverId: string, callType: P2PCallType) => void;
  acceptCall: (callId: string) => void;
  declineCall: (callId: string) => void;
  endCall: () => void;
  toggleMute: () => void;
  toggleVideo: () => void;
  toggleScreenShare: () => void;
  startWebRTC: (isCaller: boolean) => Promise<void>;
  cleanup: () => void;

  // ─── WS Event Handlers ───
  handleCallInitiate: (data: P2PCall) => void;
  handleCallAccept: (data: { call_id: string }) => void;
  handleCallDecline: (data: { call_id: string; reason?: string }) => void;
  handleCallEnd: (data: { call_id: string; reason?: string }) => void;
  handleCallBusy: (data: { receiver_id: string }) => void;
  handleSignal: (data: P2PSignalPayload) => void;
};

// ─── Store ───

export const useP2PCallStore = create<P2PCallStore>((set, get) => {
  const noScreenAudioStop = () => {};
  let screenAudioSession: P2PScreenAudioSession | null = null;
  let unsubscribeScreenAudio: (() => void) | null = null;
  const retireScreenAudio = (status: P2PScreenAudioStatus = "off") => {
    const previous = screenAudioSession; screenAudioSession = null;
    unsubscribeScreenAudio?.(); unsubscribeScreenAudio = null;
    set({ screenAudioRequested: false, screenAudioStatus: status, stopScreenAudio:noScreenAudioStop });
    previous?.stop();
  };
  let screenTicket: symbol | null = null;
  let screenRestoring = false;
  let screenSession: StartScreenShareResult | null = null;
  let unsubscribeScreenQuality: (() => void) | null = null;
  const retireScreen = () => { retireScreenAudio(); screenTicket = null; set({isScreenSharePending:false}); screenRestoring = false; unsubscribeScreenQuality?.(); unsubscribeScreenQuality = null; screenSession?.dispose(); screenSession = null; };
  let cameraPending = false;
  let cameraRecord:{call:P2PCall;pc:RTCPeerConnection;stream:MediaStream;owner:P2PCameraSession}|null=null;
  const cameraFor=(call:P2PCall,pc:RTCPeerConnection,stream:MediaStream)=>{
    const auth=getAuthSessionSnapshot(),user=useAuthStore.getState().user?.id;
    if(call.status!=="active"||!auth.ownerId||user!==auth.ownerId||![call.caller_id,call.receiver_id].includes(user))return null;
    if(cameraRecord?.call===call&&cameraRecord.pc===pc&&cameraRecord.stream===stream)return cameraRecord.owner;
    const prior=cameraRecord;cameraRecord=null;prior?.owner.dispose();cameraPending=false;
    let cameraSourceSender=pc.getSenders().find(sender=>sender.track?.kind==="video")??null;
    const scope=JSON.stringify(auth);
    const current=()=>cameraRecord?.owner===owner&&get().activeCall===call&&get().peerConnection===pc&&get().localStream===stream&&JSON.stringify(getAuthSessionSnapshot())===scope;
    const owner=new P2PCameraSession({current,sharing:()=>screenTicket!==null||get().isScreenSharing||!!get()._screenSender,stream,pc,enabled:get().isVideoOn,state:enabled=>{if(current()){
      set({isVideoOn:enabled});const track=stream.getVideoTracks()[0],sender=pc.getSenders().find(value=>value.track===track);
      if(enabled&&sender){cameraSourceSender=sender;registerP2PLocalSource(pc,sender,"camera");}
      else if(!enabled&&!screenTicket&&!get().isScreenSharing&&!screenRestoring&&cameraSourceSender){const source=getP2PMediaController(pc)?.getLocalSource(cameraSourceSender);if(source===undefined||source===null||source==="camera")registerP2PLocalSource(pc,cameraSourceSender,null);}
    }},busy:pending=>{if(current())cameraPending=pending;},error:error=>{if(current())useToastStore.getState().addToast("error",i18n.t(`settings:${cameraErrorKey(error)}`));}});
    cameraRecord={call,pc,stream,owner};owner.activate();return owner;
  };
  let microphone: P2PMicrophoneSession | null = null;
  const microphoneNow=():P2PMicrophoneSession|null=>microphone;
  let audioSender: {pc:RTCPeerConnection;sender:RTCRtpSender}|null=null;
  let initialRetry: {call:P2PCall;offer?:P2PSignalPayload}|null=null;
  let startingCall: {call:P2PCall;ticket:symbol} | null = null;
  let preparation: { call: P2PCall; promise: Promise<MediaStream> } | null = null;
  const prepareMedia = (call: P2PCall) => {
    if (preparation?.call === call) return preparation.promise;
    microphone?.dispose();
    const auth=getAuthSessionSnapshot();
    const owner=useAuthStore.getState().user?.id;
    const current=()=>!!owner&&auth.ownerId===owner&&useAuthStore.getState().user?.id===owner
      &&getAuthSessionSnapshot().ownerId===owner&&getAuthSessionSnapshot().generation===auth.generation&&get().activeCall===call&&call.status==="active"&&(call.caller_id===owner||call.receiver_id===owner);
    if(!current())return Promise.reject(new DOMException("Call session expired","AbortError"));
    const session: P2PMicrophoneSession = new P2PMicrophoneSession({
      isCurrent: () => microphone === session && current(),
      subscribeScope: retire=>useP2PCallStore.subscribe(state=>{if(state.activeCall!==call)retire();}),
      isMuted: () => get().isMuted || useVoiceStore.getState().isDeafened,
      manualMuted: () => get().isMuted,
      replaceTrack: async (previous, next, candidateCurrent=()=>true) => {
        const { peerConnection, localStream } = get();
        if (microphone !== session || !current() || !candidateCurrent() || !peerConnection || !localStream) return false;
        const sender = peerConnection.getSenders().find((candidate) => candidate.track === previous)
          ?? (audioSender?.pc===peerConnection && peerConnection.getSenders().includes(audioSender.sender) ? audioSender.sender : undefined);
        if (!sender) throw new Error("P2P microphone sender is unavailable");
        next.enabled = false;
        await sender.replaceTrack(next);
        if (microphone !== session || get().peerConnection !== peerConnection || !current() || !candidateCurrent()) {next.enabled=false;return false;}
        return true;
      },
      commitTrack:(previous,next)=>{
        const {peerConnection,localStream}=get();
        if(microphone!==session||!current()||!peerConnection||!localStream||audioSender?.pc!==peerConnection||audioSender.sender.track!==next)return false;
        localStream.removeTrack(previous);localStream.addTrack(next);return true;
      },
      onError: (error) => {
        if(microphone!==session||!current())return;
        set({microphoneFailure:{call,ownerId:owner!,generation:auth.generation}});
        console.error("[p2p] Microphone capture unavailable:", error);
        useToastStore.getState().addToast("error", i18n.t("voice:p2pMicrophoneUnavailable"));
      },
    });
    microphone = session;
    const promise = session.start(call.call_type === "video" ? selectedCameraConstraints() : false);
    preparation = { call, promise };
    return promise;
  };
  /** Build the callbacks object that webrtc/p2pPeerConnection wires up. */
  let videoBinding:ReturnType<typeof bindAuthorizedVideoSources>|null=null;let videoPresentationOff:(()=>void)|null=null;
  const pcCallbacks = (call:P2PCall) => {
    const auth=JSON.stringify(getAuthSessionSnapshot());
    let ownedPC:RTCPeerConnection|null=null;
    const current=()=>get().activeCall===call&&call.status==="active"&&JSON.stringify(getAuthSessionSnapshot())===auth;
    videoBinding?.release();videoPresentationOff?.();
    const peer=(call.caller_id===getAuthSessionSnapshot().ownerId?(call.receiver_display_name??call.receiver_username??call.receiver_id):(call.caller_display_name??call.caller_username??call.caller_id));
    const videoIds=new WeakMap<MediaStreamTrack,string>(),videoSources=new WeakMap<MediaStreamTrack,AuthorizedVideoSource>();
    const binding=bindAuthorizedVideoSources("p2p",crypto.randomUUID(),peer,current,()=>isPresentedVideoContext(call.id,"p2p"));videoBinding=binding;videoPresentationOff=subscribeVideoPresentation(()=>binding.refresh());
    return {
      onRemoteMedia:(media:import("../webrtc/p2pMediaController").P2PRemoteMedia)=>{if(current()&&ownedPC!==null&&get().peerConnection===ownedPC){if(!media.screenAudioSupported)retireScreenAudio();set({remoteStream:media.video,remoteCameraStream:media.camera??null,remoteScreenVideoStream:media.screenVideo??null,remoteMicrophoneStream:media.microphone,remoteScreenAudioStream:media.screenAudio,peerScreenAudioSupported:media.screenAudioSupported});
        const pc=get().peerConnection;
        const sources:AuthorizedVideoSource[]=[];
        for(const [kind,stream]of [["camera",media.camera],["screen",media.screenVideo]]as const)for(const track of stream?.getVideoTracks()??[]){
          const sourceCurrent=()=>current()&&get().peerConnection===pc&&!!pc&&pc.connectionState!=="closed"&&track.readyState==="live"&&(kind==="camera"?get().remoteCameraStream:get().remoteScreenVideoStream)?.getVideoTracks().includes(track)===true;
          let tileId=videoIds.get(track);if(!tileId){tileId=crypto.randomUUID();videoIds.set(track,tileId)}
          let source=videoSources.get(track);if(!source||source.kind!==kind){source={origin:"p2p",tileId,kind,track,current:sourceCurrent,subscribeScope:changed=>useP2PCallStore.subscribe(changed),addViewport:()=>null};videoSources.set(track,source)}sources.push(source);
        }
        binding.update(sources,media.video&&!media.camera&&!media.screenVideo?"legacy-video":undefined);
      }},
      isCurrent:(pc:RTCPeerConnection)=>{if(ownedPC===null)ownedPC=pc;return ownedPC===pc&&current()&&get().peerConnection===pc;},
      isCaller:call.caller_id===getAuthSessionSnapshot().ownerId,
      onTerminated:()=>{if(current())get().endCall();},
    };
  };

  return {
    activeCall: null,
    incomingCall: null,
    localStream: null,
    remoteStream: null,
    remoteCameraStream:null,remoteScreenVideoStream:null,
    remoteMicrophoneStream: null,
    remoteScreenAudioStream: null,
    peerScreenAudioSupported: false,
    screenAudioRequested: false,
    screenAudioStatus: "off",
    peerConnection: null,
    _screenSender: null,
    microphoneFailure:null,
    microphoneRetrying:false,
    isMuted: false,
    isVideoOn: false,
    isScreenSharing: false,
    isScreenSharePending: false,
    callDuration: 0,
    _durationInterval: null,
    _pendingCandidates: [],
    _sendWS: null,

    registerSendWS: (fn) => set({ _sendWS: fn }),

    initiateCall: (receiverId, callType) => {
      get()._sendWS?.("p2p_call_initiate", { receiver_id: receiverId, call_type: callType });
    },

    acceptCall: (callId) => {
      const { _sendWS, incomingCall } = get();
      if (!_sendWS || !incomingCall) return;
      _sendWS("p2p_call_accept", { call_id: callId });
    },

    declineCall: (callId) => {
      get()._sendWS?.("p2p_call_decline", { call_id: callId });
      set({ incomingCall: null, activeCall: null });
    },

    endCall: () => {
      get()._sendWS?.("p2p_call_end");
      get().cleanup();
    },

    retryMicrophone: async (expectedCall,useDefault=false) => {
      const failure=get().microphoneFailure,session=microphone,auth=getAuthSessionSnapshot();
      const current=()=>get().activeCall===expectedCall&&get().activeCall?.status==="active"
        &&!!failure&&failure.call===expectedCall&&auth.ownerId===failure.ownerId&&getAuthSessionSnapshot().ownerId===failure.ownerId
        &&auth.generation===failure.generation&&getAuthSessionSnapshot().generation===failure.generation
        &&useAuthStore.getState().user?.id===failure.ownerId;
      if(!current()||get().microphoneRetrying||!session)return false;
      set({microphoneRetrying:true});
      try {
        if(useDefault){if(!current())return false;useVoiceStore.getState().setInputDevice("");}
        if(!current())return false;
        let success=false;
        if(get().peerConnection&&get().localStream) success=await session.retry();
        else {
          const retry=initialRetry;if(!retry||retry.call!==expectedCall)return false;
          session.dispose();microphone=null;preparation=null;startingCall=null;
          if(retry.offer)await get().handleSignal(retry.offer);else await get().startWebRTC(true);
          const recovered=microphoneNow();success=!!get().peerConnection&&!!get().localStream&&!!recovered&&!recovered.hasFailed;
        }
        if(!current())return false;
        if(success)set({microphoneFailure:null});
        return success;
      }finally{if(get().activeCall===expectedCall&&getAuthSessionSnapshot().ownerId===auth.ownerId&&getAuthSessionSnapshot().generation===auth.generation)set({microphoneRetrying:false});}
    },
    toggleMute: () => {
      set({ isMuted: !get().isMuted });
      microphone?.syncMute();
    },

    toggleVideo: () => {
      const{localStream,peerConnection,activeCall}=get();
      if(localStream&&peerConnection&&activeCall)cameraFor(activeCall,peerConnection,localStream)?.toggle();
    },

    setScreenAudioRequested: requested => {
      const state=get(),auth=getAuthSessionSnapshot(),call=state.activeCall,pc=state.peerConnection;
      if(!call||call.status!=="active"||!pc||!auth.ownerId||useAuthStore.getState().user?.id!==auth.ownerId||![call.caller_id,call.receiver_id].includes(auth.ownerId)||state.isScreenSharing||screenTicket||!state.peerScreenAudioSupported||!getP2PMediaController(pc)?.canSendScreenAudio())return;
      set({screenAudioRequested:requested,screenAudioStatus:"off"});
    },
    stopScreenAudio: noScreenAudioStop,
    toggleScreenShare: () => {
      const { activeCall, peerConnection, localStream, isScreenSharing } = get();
      if (screenRestoring) { useToastStore.getState().addToast("error", i18n.t("voice:screenShareRestoring")); return; }
      if (isScreenSharing || screenTicket) {
        const previous = screenSession;
        retireScreen();
        set({ _screenSender: null, isScreenSharing: false });
        if (previous && previous.sender.track === previous.track && activeCall && peerConnection && localStream) {
          // The display source ended even if camera restoration later fails.
          if(getP2PMediaController(peerConnection)?.getLocalSource(previous.sender)==="screen-video")registerP2PLocalSource(peerConnection,previous.sender,null);
          const ticket = Symbol("screen-camera-restore"), auth = JSON.stringify(getAuthSessionSnapshot());
          screenTicket = ticket; screenRestoring = true;set({isScreenSharePending:true});
          const current = () => screenTicket === ticket && get().activeCall === activeCall && activeCall.status === "active" && get().peerConnection === peerConnection && get().localStream === localStream && JSON.stringify(getAuthSessionSnapshot()) === auth;
          void (async () => {
            while (current()) {
              const camera = get().isVideoOn ? localStream.getVideoTracks()[0] ?? null : null;
              const restored = await stopScreenShare(previous.sender, camera, current);
              if(restored&&current())registerP2PLocalSource(peerConnection,previous.sender,camera?"camera":null);
              if (!restored || !current() || camera === (get().isVideoOn ? localStream.getVideoTracks()[0] ?? null : null)) break;
            }
          })().catch(() => { if (current()) useToastStore.getState().addToast("error", i18n.t("voice:screenShareQualityFailed")); }).finally(() => { if (screenTicket === ticket) { screenTicket = null; screenRestoring = false; set({isScreenSharePending:false}); } });
        }
        return;
      }
      if (!activeCall || activeCall.status !== "active" || !peerConnection || !localStream) return;
      if (cameraPending) { useToastStore.getState().addToast("error", i18n.t("voice:screenShareCameraPending")); return; }
      const auth = getAuthSessionSnapshot();
      if (!auth.ownerId || useAuthStore.getState().user?.id !== auth.ownerId || (activeCall.caller_id !== auth.ownerId && activeCall.receiver_id !== auth.ownerId)) return;
      const requestedAudio=get().screenAudioRequested&&get().peerScreenAudioSupported&&!!getP2PMediaController(peerConnection)?.canSendScreenAudio();
      if(!requestedAudio&&get().screenAudioRequested)set({screenAudioRequested:false,screenAudioStatus:"off"});
      const ticket = Symbol("screen-share"); screenTicket = ticket;
      const current = () => screenTicket === ticket && activeCall.status === "active" && get().activeCall === activeCall && get().peerConnection === peerConnection && get().localStream === localStream
        && useAuthStore.getState().user?.id === auth.ownerId && getAuthSessionSnapshot().ownerId === auth.ownerId && getAuthSessionSnapshot().generation === auth.generation;
      const settings = useVoiceStore.getState();
      const display = { width: window.screen.width, height: window.screen.height, refreshRate: 0 };
      // Bind the rendered action to this operation. A retained old action may
      // never stop a replacement call or a later share on the same call.
      set({isScreenSharePending:true,stopScreenAudio:()=>{if(current())retireScreenAudio();}});
      const audioCurrent=()=>current()&&requestedAudio&&get().screenAudioRequested&&get().peerScreenAudioSupported&&!!getP2PMediaController(peerConnection)?.canSendScreenAudio();
      void startScreenShare(peerConnection, { audioRequested:requestedAudio, audioCurrent,
        restoreCurrent:()=>screenTicket===null&&!get().isScreenSharing&&!screenRestoring&&get().activeCall===activeCall&&activeCall.status==="active"&&get().peerConnection===peerConnection&&get().localStream===localStream&&useAuthStore.getState().user?.id===auth.ownerId&&getAuthSessionSnapshot().ownerId===auth.ownerId&&getAuthSessionSnapshot().generation===auth.generation,
        subscribeScope:retire=>useP2PCallStore.subscribe(()=>{if(!current())retire();}),
        subscribeAudioScope:retire=>useP2PCallStore.subscribe(()=>{if(!audioCurrent())retire();}), isCurrent: current, settings, display, getCameraTrack: () => get().isVideoOn ? localStream.getVideoTracks()[0] ?? null : null, getDisplayMetrics: window.electronAPI?.getDisplayInfo ? () => window.electronAPI!.getDisplayInfo() : undefined }).then(result => {
        if (!result) { if (current()) {screenTicket = null;retireScreenAudio();set({isScreenSharePending:false});} return; }
        if (!current()) { result.dispose(); return; }
        screenSession = result;
        registerP2PLocalSource(peerConnection,result.sender,"screen-video");
        result.track.onended = () => { if (current() && screenSession === result) get().toggleScreenShare(); };
        let chain = Promise.resolve().then(async () => { if (current() && screenSession === result) await result.update(useVoiceStore.getState()); }).catch(() => { if (current()) useToastStore.getState().addToast("error", i18n.t("voice:screenShareQualityFailed")); });
        unsubscribeScreenQuality = useVoiceStore.subscribe((next, previous) => {
          if (next.screenShareQuality === previous.screenShareQuality && next.screenShareFps === previous.screenShareFps) return;
          chain = chain.then(async () => { if (current() && screenSession === result) await result.update(useVoiceStore.getState()); }).catch(() => {
            if (current()) useToastStore.getState().addToast("error", i18n.t("voice:screenShareQualityFailed"));
          });
        });
        set({ _screenSender: result.sender, isScreenSharing: true, isScreenSharePending:false });
        const controller=getP2PMediaController(peerConnection);
        if(requestedAudio&&get().screenAudioRequested&&controller?.canSendScreenAudio()&&get().peerScreenAudioSupported&&current()){
          let instance:P2PScreenAudioSession|null=null;
          const sourceCurrent=()=>instance!==null&&screenAudioSession===instance&&screenSession===result&&result.track.readyState!=="ended"&&current()&&get().screenAudioRequested&&get().peerScreenAudioSupported&&controller.canSendScreenAudio();
          instance=new P2PScreenAudioSession({pc:peerConnection,sourceNonce:crypto.randomUUID(),current:sourceCurrent,controller,
            subscribeScope:retire=>useP2PCallStore.subscribe(()=>{if(!sourceCurrent())retire();}),
            state:status=>{if(!sourceCurrent())return;if(status==="ended"||status==="unavailable"||status==="not_returned"){screenAudioSession=null;unsubscribeScreenAudio?.();unsubscribeScreenAudio=null;set({screenAudioStatus:status,screenAudioRequested:false,stopScreenAudio:noScreenAudioStop});}else set({screenAudioStatus:status});},
          });
          screenAudioSession=instance;
          set({stopScreenAudio:()=>{if(sourceCurrent())retireScreenAudio();}});
          unsubscribeScreenAudio=useP2PCallStore.subscribe(()=>{if(screenAudioSession===instance&&!sourceCurrent())retireScreenAudio();});
          void instance.start({native:isElectron(),browserTrack:result.audioTrack});
        }else if(result.audioTrack){result.audioTrack.enabled=false;result.audioTrack.stop();}

      }).catch(error => {
        if (current()) { screenTicket = null;retireScreenAudio();set({isScreenSharePending:false}); console.error("[p2p] Screen share error:", error); useToastStore.getState().addToast("error", i18n.t("voice:screenShareQualityFailed")); }
      });
    },

    startWebRTC: async (isCaller) => {
      const { activeCall, _sendWS } = get();
      if (!activeCall || activeCall.status!=="active" || !_sendWS) return;

      // Receiver defers media acquisition to handleSignal("offer") to avoid
      // racing with concurrent getUserMedia calls.
      if (!isCaller) return;
      if (startingCall?.call === activeCall) return;
      const authScope=JSON.stringify(getAuthSessionSnapshot());
      let preparedSession:P2PMicrophoneSession|null=null;
      const currentStart=()=>get().activeCall===activeCall&&JSON.stringify(getAuthSessionSnapshot())===authScope&&(!preparedSession||microphone===preparedSession);
      const startTicket={call:activeCall,ticket:Symbol("p2p-start")};
      startingCall = startTicket;
      initialRetry={call:activeCall};

      try {
        const media=prepareMedia(activeCall);preparedSession=microphone;
        const stream = await media;
        if (!currentStart()) { stopAllTracks(stream); return; }
        set({ localStream: stream, isVideoOn: activeCall.call_type === "video" });
        microphone?.syncMute();

        const pc = createPeerConnection(activeCall.id, _sendWS, pcCallbacks(activeCall));
        set({ peerConnection: pc });
        // addTrack triggers onnegotiationneeded; PC's handler creates the offer.
        for (const track of stream.getTracks()) {const sender=pc.addTrack(track, stream);if(track.kind==="audio")audioSender={pc,sender};registerP2PLocalSource(pc,sender,track.kind==="audio"?"microphone":"camera");}
        applyDegradationPreference(pc);
        microphone?.connect();cameraFor(activeCall,pc,stream);
      } catch (err) {
        console.error("[p2p] WebRTC start error:", err);
        if (currentStart() && get().microphoneFailure?.call!==activeCall) get().cleanup();
      } finally {
        if (startingCall === startTicket) startingCall = null;
      }
    },

    cleanup: () => {
      videoBinding?.release();videoBinding=null;videoPresentationOff?.();videoPresentationOff=null;
      const priorCamera=cameraRecord;cameraRecord=null;priorCamera?.owner.dispose();cameraPending=false;
      retireScreen();
      const { localStream, remoteStream, peerConnection, _durationInterval } = get();
      microphone?.dispose();
      microphone = null;
      preparation = null;
      startingCall = null;
      audioSender=null;initialRetry=null;

      // Stop all PC sender/receiver tracks first (covers screen-share track
      // not present in localStream).
      if (peerConnection) {
        getP2PMediaController(peerConnection)?.dispose();
        for (const sender of peerConnection.getSenders()) sender.track?.stop();
        for (const receiver of peerConnection.getReceivers()) receiver.track?.stop();
      }

      // Safety net for any tracks still attached to the streams.
      stopAllTracks(localStream);
      stopAllTracks(remoteStream);

      peerConnection?.close();
      if (_durationInterval) clearInterval(_durationInterval);

      set({
        activeCall: null,
        microphoneFailure:null,microphoneRetrying:false,
        incomingCall: null,
        localStream: null,
        remoteStream: null,
    remoteCameraStream:null,remoteScreenVideoStream:null,
        remoteMicrophoneStream: null,
        remoteScreenAudioStream: null,
        peerScreenAudioSupported: false,
        screenAudioRequested: false,
        screenAudioStatus: "off",
        peerConnection: null,
        _screenSender: null,
        isMuted: false,
        isVideoOn: false,
        isScreenSharing: false,
        isScreenSharePending: false,
        stopScreenAudio:noScreenAudioStop,
        callDuration: 0,
        _durationInterval: null,
        _pendingCandidates: [],
      });
    },

    // ─── WS Event Handlers ───

    handleCallInitiate: (data) => {
      const { activeCall } = get();
      if (activeCall) {
        // Already in a call — surface as an incoming overlay
        set({ incomingCall: data });
      } else {
        // Both caller and receiver receive this. Component layer decides
        // role based on callerId vs current userId.
        set({ activeCall: data, incomingCall: data });
      }
    },

    handleCallAccept: (data) => {
      const { activeCall } = get();
      if (!activeCall || activeCall.id !== data.call_id || activeCall.status==="active") return;

      set({ activeCall: { ...activeCall, status: "active" }, incomingCall: null });

      const interval = setInterval(() => {
        set((state) => ({ callDuration: state.callDuration + 1 }));
      }, 1000);
      set({ _durationInterval: interval });
    },

    handleCallDecline: (data) => {
      const { activeCall, incomingCall } = get();
      const t = i18n.t.bind(i18n);

      if (activeCall && activeCall.id === data.call_id) {
        useToastStore.getState().addToast("info", t("common:callDeclined"));
        get().cleanup();
        return;
      }

      if (incomingCall && incomingCall.id === data.call_id) {
        set({ incomingCall: null });
      }
    },

    handleCallEnd: (data) => {
      if(!data || typeof data.call_id!=="string" || !data.call_id)return;
      const {activeCall,incomingCall}=get();
      if(activeCall?.id===data.call_id){
        if(data.reason==="no_answer" && activeCall.status==="ringing" && activeCall.caller_id===useAuthStore.getState().user?.id){
          useToastStore.getState().addToast("info",i18n.t("common:callNoAnswer"));
        }
        get().cleanup();
      }else if(incomingCall?.id===data.call_id){
        set({incomingCall:null});
      }
    },

    handleCallBusy: () => {
      const t = i18n.t.bind(i18n);
      useToastStore.getState().addToast("warning", t("common:userBusy"));
      get().cleanup();
    },

    handleSignal: async (data) => {
      const { peerConnection, activeCall, _sendWS } = get();
      if (!activeCall || activeCall.status!=="active" || data.call_id !== activeCall.id) return;
      if(data.type==="offer"||data.type==="answer"){try{validateP2PDescription(data)}catch{return;}}
      const authScope=JSON.stringify(getAuthSessionSnapshot());
      let signalSession:P2PMicrophoneSession|null=microphone;
      const currentSignal=()=>get().activeCall===activeCall&&JSON.stringify(getAuthSessionSnapshot())===authScope&&(!signalSession||microphone===signalSession);

      switch (data.type) {
        case "offer": {
          // Two scenarios:
          //   A) Initial offer (no PC yet) → create PC, add local tracks, answer
          //   B) Mid-call renegotiation (PC exists) → setRemoteDescription + answer
          let pc = peerConnection;

          if (!pc) {
            if (!activeCall || !_sendWS) break;
            // Acquire local media if we don't have it yet (receiver path).
            // setRemoteDescription is awaited below so onnegotiationneeded
            // fired by addTrack here cannot race past the offer state machine.
            let stream = get().localStream;
            if (!stream) {
              try {
                initialRetry={call:activeCall,offer:{...data}};
                const media=prepareMedia(activeCall);signalSession=microphone;
                stream = await media;
                if (!currentSignal()) {
                  stopAllTracks(stream);
                  return;
                }
                set({ localStream: stream, isVideoOn: activeCall.call_type === "video" });
        microphone?.syncMute();
              } catch (err) {
                console.error("[p2p] Failed to get media in handleSignal:", err);
                if (currentSignal() && get().microphoneFailure?.call!==activeCall) get().cleanup();
                return;
              }
            }
            // Another offer may have completed the shared media acquisition first.
            pc = get().peerConnection;
            if (!pc) {
              pc = createPeerConnection(activeCall.id, _sendWS, pcCallbacks(activeCall));
              set({ peerConnection: pc });
              try {
                if (stream) {
                  for (const track of stream.getTracks()) {const sender=pc.addTrack(track, stream);if(track.kind==="audio")audioSender={pc,sender};registerP2PLocalSource(pc,sender,track.kind==="audio"?"microphone":"camera");}
                }
                applyDegradationPreference(pc);
                microphone?.connect();if(stream)cameraFor(activeCall,pc,stream);
              } catch (error) {
                console.error("[p2p] Failed to attach local media:", error);
                if (get().peerConnection === pc) get().cleanup();
                return;
              }
            }
          }

          const controller=getP2PMediaController(pc);
          if (!controller || !currentSignal() || get().peerConnection!==pc) return;
          try{await controller.applyRemoteDescription(data)}catch{return;}
          if(currentSignal()&&get().peerConnection===pc)await flushPendingCandidates(pc,get,set);
          break;
        }

        case "answer": {
          if (!peerConnection) return;
          const controller=getP2PMediaController(peerConnection);
          if(!controller||!currentSignal())return;
          try{if(await controller.applyRemoteDescription(data)==="accepted"&&currentSignal()&&get().peerConnection===peerConnection)await flushPendingCandidates(peerConnection,get,set)}catch{return;}
          break;
        }

        case "ice-candidate": {
          if (!data.candidate) break;
          const candidate = data.candidate as RTCIceCandidateInit;

          // ICE candidates can arrive before the matching SDP — addIceCandidate
          // throws InvalidStateError if remoteDescription isn't set yet, so
          // we queue and flush after each setRemoteDescription.
          if (!peerConnection || !peerConnection.remoteDescription) {
            set((state) => ({ _pendingCandidates: [...state._pendingCandidates.slice(-127), candidate] }));
          } else {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          }
          break;
        }
      }
    },
  };
});

// Authentication replacement retires capture immediately, including pending GUM.
const retirePrivateCall=()=>{if(useP2PCallStore.getState().activeCall)useP2PCallStore.getState().cleanup();};
subscribeAuthOwnerChanges(retirePrivateCall);subscribeAuthGenerationChanges(retirePrivateCall);
useP2PCallStore.subscribe((state,previous)=>{
  if(state.activeCall!==previous.activeCall&&state.microphoneFailure&&state.microphoneFailure.call!==state.activeCall)
    useP2PCallStore.setState({microphoneFailure:null,microphoneRetrying:false});
});

/** Drain the queued ICE candidates after remoteDescription is set. */
async function flushPendingCandidates(
  pc: RTCPeerConnection,
  get: () => P2PCallStore,
  set: (partial: Partial<P2PCallStore>) => void,
): Promise<void> {
  const pending = get()._pendingCandidates;
  if (pending.length === 0) return;
  set({ _pendingCandidates: [] });
  for (const c of pending) {
    await pc.addIceCandidate(new RTCIceCandidate(c));
  }
}
