/**
 * webrtc/p2pPeerConnection.ts — RTCPeerConnection factory + WebRTC primitives.
 *
 * Single responsibility: own the RTCPeerConnection construction + handler
 * wiring (ICE candidate relay, ontrack, connection-state monitoring,
 * onnegotiationneeded glare prevention). Returns a wired-up PC that the
 * caller adds tracks to.
 *
 * Glare prevention: a single `makingOffer` + `signalingState` guard ensures
 * we don't emit two simultaneous offers. This is the only place offers are
 * created — both initial and mid-call renegotiation routes through here.
 */

import { logToServer } from "../api/clientLog";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/** WS sender signature — kept narrow so we don't pull in store types. */
export type SendWS = (op: string, data?: unknown) => void;

export interface PeerConnectionCallbacks {
  /** Called whenever the remote stream changes — caller stores it. */
  onRemoteStream: (stream: MediaStream) => void;
  /** Read current remote stream (for mid-call addTransceiver track aggregation). */
  getRemoteStream: () => MediaStream | null;
  /** Called when the connection has irrecoverably failed/closed. */
  onTerminated: () => void;
}

/** Set "balanced" degradation on all current video senders (resolution + FPS degrade together). */
export function applyDegradationPreference(pc: RTCPeerConnection): void {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    const params = sender.getParameters();
    params.degradationPreference = "balanced";
    sender.setParameters(params).catch((err) => {
      console.warn("[p2p] Failed to set degradationPreference:", err);
      logToServer("warn", "p2p_degradation_pref_failed", {
        errorMessage:
          err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        errorName: err instanceof Error ? err.name : typeof err,
      });
    });
  }
}

/**
 * Create a fully wired RTCPeerConnection. Caller is responsible for adding
 * tracks (which kicks off the offer flow via onnegotiationneeded).
 */
export function createPeerConnection(
  callId: string,
  sendWS: SendWS,
  callbacks: PeerConnectionCallbacks,
): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Relay new ICE candidates to the remote peer
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWS("p2p_signal", {
        call_id: callId,
        type: "ice-candidate",
        candidate: event.candidate.toJSON(),
      });
    }
  };

  // Mid-call renegotiation (e.g. screen share addTransceiver) emits ontrack
  // without populating event.streams[0]. In that case we need to splice the
  // new track into the existing remote stream so the audio side keeps playing.
  pc.ontrack = (event) => {
    if (event.streams[0]) {
      callbacks.onRemoteStream(event.streams[0]);
      return;
    }
    const existing = callbacks.getRemoteStream();
    const stream = new MediaStream(existing ? existing.getTracks() : []);
    stream.addTrack(event.track);
    callbacks.onRemoteStream(stream);
  };

  // Connection-state monitoring with debounce on transient "disconnected".
  // During renegotiation (signalingState !== "stable") ICE may briefly drop —
  // we wait longer in that case before declaring the call dead.
  let disconnectedTimer: ReturnType<typeof setTimeout> | null = null;

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected" || pc.connectionState === "connecting") {
      if (disconnectedTimer) {
        clearTimeout(disconnectedTimer);
        disconnectedTimer = null;
      }
      return;
    }

    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      if (disconnectedTimer) {
        clearTimeout(disconnectedTimer);
        disconnectedTimer = null;
      }
      console.warn("[p2p] PeerConnection state:", pc.connectionState);
      logToServer("warn", "p2p_connection_terminated", {
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState,
        callId,
      });
      callbacks.onTerminated();
      return;
    }

    if (pc.connectionState === "disconnected") {
      // Renegotiating? Give it more slack before terminating.
      const timeout = pc.signalingState !== "stable" ? 10000 : 5000;
      console.warn("[p2p] PeerConnection disconnected, waiting for recovery...", {
        signalingState: pc.signalingState,
        timeout,
      });
      if (!disconnectedTimer) {
        // Single log per transient-disconnect cycle — gated by the same
        // `!disconnectedTimer` check that protects against ICE re-check spam.
        logToServer("info", "p2p_disconnected_transient", {
          signalingState: pc.signalingState,
          iceConnectionState: pc.iceConnectionState,
          recoveryTimeoutMs: timeout,
          callId,
        });
        disconnectedTimer = setTimeout(() => {
          disconnectedTimer = null;
          if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            console.warn("[p2p] PeerConnection did not recover, ending call");
            logToServer("warn", "p2p_recovery_timeout", {
              finalConnectionState: pc.connectionState,
              iceConnectionState: pc.iceConnectionState,
              signalingState: pc.signalingState,
              timeoutMs: timeout,
              callId,
            });
            callbacks.onTerminated();
          }
        }, timeout);
      }
    }
  };

  // onnegotiationneeded — auto-offer creation after addTrack/addTransceiver.
  // Single offer-creation point; the makingOffer + signalingState guard
  // prevents glare with a concurrent incoming offer.
  let makingOffer = false;
  pc.onnegotiationneeded = async () => {
    if (makingOffer || pc.signalingState !== "stable") return;
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendWS("p2p_signal", {
        call_id: callId,
        type: "offer",
        sdp: offer.sdp,
      });
    } catch (err) {
      console.error("[p2p] Renegotiation error:", err);
      logToServer("error", "p2p_renegotiation_failed", {
        errorMessage:
          err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        errorName: err instanceof Error ? err.name : typeof err,
        errorStack: err instanceof Error && err.stack ? err.stack.slice(0, 1024) : "",
        signalingState: pc.signalingState,
        callId,
      });
    } finally {
      makingOffer = false;
    }
  };

  return pc;
}
