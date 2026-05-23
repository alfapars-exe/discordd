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

// ─── Helpers ───

/** Acquire a local mic (+ optional camera) stream for a call. */
async function getMediaStream(callType: P2PCallType): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    // Match VoiceProvider's audioCaptureDefaults: mono + the standard
    // WebRTC enhancers. Without channelCount:1 some mics expose a stereo
    // pair with one silent channel and the remote hears audio in one ear.
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video:
      callType === "video"
        ? { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
        : false,
  });
}

/** Acquire a single high-quality camera track (used by toggleVideo). */
async function getCameraTrack(): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
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
  /** Build the callbacks object that webrtc/p2pPeerConnection wires up. */
  const pcCallbacks = () => ({
    onRemoteStream: (s: MediaStream) => set({ remoteStream: s }),
    getRemoteStream: () => get().remoteStream,
    onTerminated: () => {
      if (get().activeCall) get().endCall();
    },
  });

  return {
    activeCall: null,
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

    toggleMute: () => {
      const { localStream, isMuted } = get();
      if (localStream) {
        for (const track of localStream.getAudioTracks()) track.enabled = isMuted;
      }
      set({ isMuted: !isMuted });
    },

    toggleVideo: () => {
      const { localStream, isVideoOn, peerConnection, activeCall } = get();
      if (!localStream || !peerConnection || !activeCall) return;

      if (isVideoOn) {
        for (const track of localStream.getVideoTracks()) track.enabled = false;
        set({ isVideoOn: false });
        return;
      }

      const existing = localStream.getVideoTracks()[0];
      if (existing) {
        existing.enabled = true;
        set({ isVideoOn: true });
        return;
      }

      // No video track yet — acquire one. addTrack triggers
      // onnegotiationneeded so renegotiation happens automatically.
      getCameraTrack()
        .then((videoTrack) => {
          localStream.addTrack(videoTrack);
          peerConnection.addTrack(videoTrack, localStream);
          set({ isVideoOn: true });
        })
        .catch((err) => {
          console.error("[p2p] Failed to get video:", err);
        });
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
      if (!activeCall || !_sendWS) return;

      // Receiver defers media acquisition to handleSignal("offer") to avoid
      // racing with concurrent getUserMedia calls.
      if (!isCaller) return;

      try {
        const stream = await getMediaStream(activeCall.call_type);
        set({ localStream: stream, isVideoOn: activeCall.call_type === "video" });

        const pc = createPeerConnection(activeCall.id, _sendWS, pcCallbacks());
        // addTrack triggers onnegotiationneeded; PC's handler creates the offer.
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
        applyDegradationPreference(pc);
        set({ peerConnection: pc });
      } catch (err) {
        console.error("[p2p] WebRTC start error:", err);
        get().cleanup();
      }
    },

    cleanup: () => {
      const { localStream, remoteStream, peerConnection, _durationInterval } = get();

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
      if (!activeCall || activeCall.id !== data.call_id) return;

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

    handleCallEnd: () => {
      get().cleanup();
    },

    handleCallBusy: () => {
      const t = i18n.t.bind(i18n);
      useToastStore.getState().addToast("warning", t("common:userBusy"));
      get().cleanup();
    },

    handleSignal: async (data) => {
      const { peerConnection, activeCall, _sendWS } = get();

      switch (data.type) {
        case "offer": {
          // Two scenarios:
          //   A) Initial offer (no PC yet) → create PC, add local tracks, answer
          //   B) Mid-call renegotiation (PC exists) → setRemoteDescription + answer
          let pc = peerConnection;

          if (!pc) {
            if (!activeCall || !_sendWS) break;
            pc = createPeerConnection(activeCall.id, _sendWS, pcCallbacks());

            // Acquire local media if we don't have it yet (receiver path).
            // setRemoteDescription is awaited below so onnegotiationneeded
            // fired by addTrack here cannot race past the offer state machine.
            let stream = get().localStream;
            if (!stream) {
              try {
                stream = await getMediaStream(activeCall.call_type);
                set({ localStream: stream, isVideoOn: activeCall.call_type === "video" });
              } catch (err) {
                console.error("[p2p] Failed to get media in handleSignal:", err);
              }
            }
            if (stream) {
              for (const track of stream.getTracks()) pc.addTrack(track, stream);
            }

            applyDegradationPreference(pc);
            set({ peerConnection: pc });
          }

          await pc.setRemoteDescription(
            new RTCSessionDescription({ type: "offer", sdp: data.sdp }),
          );
          await flushPendingCandidates(pc, get, set);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          const call = get().activeCall;
          const ws = get()._sendWS;
          if (ws && call) {
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
