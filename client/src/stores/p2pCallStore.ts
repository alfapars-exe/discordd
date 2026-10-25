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
import { startScreenShare, stopScreenShare } from "../webrtc/p2pScreenShare";
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

/** Acquire a single high-quality camera track (used by toggleVideo). */
async function getCameraTrack(): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: selectedCameraConstraints(),
  });
  return stream.getVideoTracks()[0];
}

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
  /** Remote media stream (received via WebRTC ontrack) */
  remoteStream: MediaStream | null;
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
  let cameraPending = false;
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
  const pcCallbacks = (call:P2PCall) => {
    const auth=JSON.stringify(getAuthSessionSnapshot());
    const current=()=>get().activeCall===call&&JSON.stringify(getAuthSessionSnapshot())===auth;
    return {
      onRemoteStream:(stream:MediaStream)=>{if(current())set({remoteStream:stream});},
      getRemoteStream:()=>current()?get().remoteStream:null,
      onTerminated:()=>{if(current())get().endCall();},
    };
  };

  return {
    activeCall: null,
    incomingCall: null,
    localStream: null,
    remoteStream: null,
    peerConnection: null,
    _screenSender: null,
    microphoneFailure:null,
    microphoneRetrying:false,
    isMuted: false,
    isVideoOn: false,
    isScreenSharing: false,
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
      const { localStream, isVideoOn, peerConnection, activeCall } = get();
      if (!localStream || !peerConnection || !activeCall || cameraPending) return;

      if (isVideoOn) {
        for (const track of localStream.getVideoTracks()) track.enabled = false;
        set({ isVideoOn: false });
        return;
      }

      cameraPending = true;
      getCameraTrack()
        .then(async (videoTrack) => {
          const current = get();
          if (current.activeCall !== activeCall || current.peerConnection !== peerConnection || current.localStream !== localStream) {
            videoTrack.stop();
            return;
          }
          const previous = localStream.getVideoTracks()[0];
          const sender = previous ? peerConnection.getSenders().find((candidate) => candidate.track === previous) : undefined;
          try {
            if (sender) await sender.replaceTrack(videoTrack);
            else peerConnection.addTrack(videoTrack, localStream);
          } catch (error) { videoTrack.stop(); throw error; }
          if (get().peerConnection !== peerConnection || get().activeCall !== activeCall) {
            videoTrack.stop();
            return;
          }
          if (previous) { localStream.removeTrack(previous); previous.stop(); }
          localStream.addTrack(videoTrack);
          set({ isVideoOn: true });
        })
        .catch((err) => {
          console.error("[p2p] Failed to get video:", err);
          if (get().activeCall === activeCall) useToastStore.getState().addToast("error", i18n.t(`settings:${cameraErrorKey(err)}`));
        }).finally(() => { cameraPending = false; });
    },

    toggleScreenShare: () => {
      const { isScreenSharing, peerConnection, localStream, _screenSender } = get();
      if (!peerConnection || !localStream) return;

      if (isScreenSharing) {
        stopScreenShare(_screenSender, localStream.getVideoTracks()[0] ?? null);
        set({ _screenSender: null, isScreenSharing: false });
        return;
      }

      startScreenShare(peerConnection)
        .then((result) => {
          if (!result) return;
          // Wire the browser's native "Stop sharing" button to our state.
          result.track.onended = () => {
            const current = get();
            if (!current.isScreenSharing) return;
            stopScreenShare(
              current._screenSender,
              current.localStream?.getVideoTracks()[0] ?? null,
            );
            set({ _screenSender: null, isScreenSharing: false });
          };
          set({ _screenSender: result.sender, isScreenSharing: true });
        })
        .catch((err) => {
          console.error("[p2p] Screen share error:", err);
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
        for (const track of stream.getTracks()) {const sender=pc.addTrack(track, stream);if(track.kind==="audio")audioSender={pc,sender};}
        applyDegradationPreference(pc);
        microphone?.connect();
      } catch (err) {
        console.error("[p2p] WebRTC start error:", err);
        if (currentStart() && get().microphoneFailure?.call!==activeCall) get().cleanup();
      } finally {
        if (startingCall === startTicket) startingCall = null;
      }
    },

    cleanup: () => {
      const { localStream, remoteStream, peerConnection, _durationInterval } = get();
      microphone?.dispose();
      microphone = null;
      preparation = null;
      startingCall = null;
      audioSender=null;initialRetry=null;

      // Stop all PC sender/receiver tracks first (covers screen-share track
      // not present in localStream).
      if (peerConnection) {
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
        peerConnection: null,
        _screenSender: null,
        isMuted: false,
        isVideoOn: false,
        isScreenSharing: false,
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
                  for (const track of stream.getTracks()) {const sender=pc.addTrack(track, stream);if(track.kind==="audio")audioSender={pc,sender};}
                }
                applyDegradationPreference(pc);
                microphone?.connect();
              } catch (error) {
                console.error("[p2p] Failed to attach local media:", error);
                if (get().peerConnection === pc) get().cleanup();
                return;
              }
            }
          }

          await pc.setRemoteDescription(
            new RTCSessionDescription({ type: "offer", sdp: data.sdp }),
          );
          await flushPendingCandidates(pc, get, set);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          const call = get().activeCall;
          const ws = get()._sendWS;
          if (ws && currentSignal() && call === activeCall && get().peerConnection === pc) {
            ws("p2p_signal", { call_id: call.id, type: "answer", sdp: answer.sdp });
          }
          break;
        }

        case "answer": {
          if (!peerConnection) return;
          // Late answer arriving after we returned to "stable" can throw —
          // ignore (we either already have an answer or are renegotiating).
          try {
            await peerConnection.setRemoteDescription(
              new RTCSessionDescription({ type: "answer", sdp: data.sdp }),
            );
          } catch (err) {
            console.warn(
              "[p2p] Could not set remote answer (state:",
              peerConnection.signalingState,
              "):",
              err,
            );
            break;
          }
          await flushPendingCandidates(peerConnection, get, set);
          break;
        }

        case "ice-candidate": {
          if (!data.candidate) break;
          const candidate = data.candidate as RTCIceCandidateInit;

          // ICE candidates can arrive before the matching SDP — addIceCandidate
          // throws InvalidStateError if remoteDescription isn't set yet, so
          // we queue and flush after each setRemoteDescription.
          if (!peerConnection || !peerConnection.remoteDescription) {
            set((state) => ({ _pendingCandidates: [...state._pendingCandidates, candidate] }));
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
