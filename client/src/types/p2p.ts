/**
 * P2P call types — WebRTC peer-to-peer voice/video between two users.
 * Group voice goes through LiveKit (voice.ts); P2P is direct between
 * browsers after server-relayed signaling.
 */

export type P2PCallType = "voice" | "video";

export type P2PCallStatus = "ringing" | "active" | "ended";

/** P2P call with both caller and receiver info. */
export type P2PCall = {
  id: string;
  caller_id: string;
  caller_username: string;
  caller_display_name: string | null;
  caller_avatar: string | null;
  receiver_id: string;
  receiver_username: string;
  receiver_display_name: string | null;
  receiver_avatar: string | null;
  call_type: P2PCallType;
  status: P2PCallStatus;
  created_at: string;
};

/**
 * WebRTC signaling data (SDP offer/answer or ICE candidate).
 * Server relays this directly to the peer without inspecting contents.
 */
export type P2PSignalPayload = {
  call_id: string;
  type: "offer" | "answer" | "ice-candidate";
  sdp?: string;
  candidate?: RTCIceCandidateInit;
};
