import { P2PMediaController, type P2PRemoteMedia } from "./p2pMediaController";
/**
 * webrtc/p2pPeerConnection.ts — RTCPeerConnection factory + WebRTC primitives.
 *
 * Single responsibility: own the RTCPeerConnection construction + handler
 * wiring (ICE candidate relay, ontrack, connection-state monitoring,
 * onnegotiationneeded glare prevention). Returns a wired-up PC that the
 * caller adds tracks to.
 *
 * One per-peer media controller serializes descriptions, stages receiver
 * tracks, and handles polite rollback or impolite glare rejection.
 */

import { logToServer } from "../api/clientLog";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

/** WS sender signature — kept narrow so we don't pull in store types. */
export type SendWS = (op: string, data?: unknown) => void;

export interface PeerConnectionCallbacks {
  onRemoteMedia: (media: P2PRemoteMedia) => void;
  isCurrent: (pc: RTCPeerConnection) => boolean;
  isCaller: boolean;
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
  let disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  const controller = new P2PMediaController(pc, { callId, polite: !callbacks.isCaller, isCaller: callbacks.isCaller,
    isCurrent: () => callbacks.isCurrent(pc), send: sendWS, onMedia: callbacks.onRemoteMedia,
    onError: () => { if (callbacks.isCurrent(pc)) callbacks.onTerminated(); },
    onDispose: () => { if (disconnectedTimer) clearTimeout(disconnectedTimer); disconnectedTimer = null; pc.ontrack = null; pc.onicecandidate = null; pc.onnegotiationneeded = null; pc.onconnectionstatechange = null; },
  });

  // Relay new ICE candidates to the remote peer
  pc.onicecandidate = (event) => {
    if (event.candidate && callbacks.isCurrent(pc)) {
      sendWS("p2p_signal", {
        call_id: callId,
        type: "ice-candidate",
        candidate: event.candidate.toJSON(),
      });
    }
  };

  pc.ontrack = (event) => controller.onTrack(event);

  // Connection-state monitoring with debounce on transient "disconnected".
  // During renegotiation (signalingState !== "stable") ICE may briefly drop —
  // we wait longer in that case before declaring the call dead.
  pc.onconnectionstatechange = () => {
    if (!callbacks.isCurrent(pc)) return;
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
          if (!callbacks.isCurrent(pc)) return;
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

  pc.onnegotiationneeded = () => controller.requestNegotiation();

  return pc;
}
