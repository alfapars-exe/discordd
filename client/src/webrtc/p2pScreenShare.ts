/**
 * webrtc/p2pScreenShare.ts — Screen-share start/stop helpers for P2P calls.
 *
 * Single responsibility: orchestrate getDisplayMedia + replaceTrack /
 * addTransceiver flow without touching the call store directly. Caller
 * passes in the PeerConnection + localStream and gets back the new
 * RTCRtpSender (so it can later restore the camera track on stop).
 *
 * Two start cases handled here:
 *   A) Camera call: an existing video sender exists → replaceTrack
 *      (no renegotiation needed).
 *   B) Voice-only call: no video sender → addTransceiver + wait for the
 *      onnegotiationneeded → setLocalDescription cycle to complete.
 */

/** Ideal display-media constraints for screen share. */
const DISPLAY_MEDIA_CONSTRAINTS: DisplayMediaStreamOptions = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 60 },
  },
};

export interface StartScreenShareResult {
  /** Sender holding the screen track (caller stores so it can stop later). */
  sender: RTCRtpSender;
  /** The screen video track itself — caller hooks onended for browser "Stop sharing" button. */
  track: MediaStreamTrack;
}

/**
 * Acquire a display-media track and either replace the existing video sender's
 * track (camera call) or add a new sendrecv video transceiver (voice-only call).
 *
 * Returns null if the user cancelled the picker or the PC was destroyed mid-flight.
 */
export async function startScreenShare(
  pc: RTCPeerConnection,
): Promise<StartScreenShareResult | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_MEDIA_CONSTRAINTS);
  } catch (err) {
    console.error("[p2p] Screen share getDisplayMedia error:", err);
    return null;
  }

  const screenTrack = stream.getVideoTracks()[0];
  if (!screenTrack) return null;

  const senders = pc.getSenders();
  let videoSender = senders.find((s) => s.track?.kind === "video");

  if (!videoSender) {
    // Voice-only call → add a new video transceiver.
    // addTransceiver triggers onnegotiationneeded — wait for it to leave
    // and re-enter "stable" before continuing, otherwise replaceTrack
    // races with setLocalDescription.
    const transceiver = pc.addTransceiver("video", { direction: "sendrecv" });
    videoSender = transceiver.sender;
    await waitForNegotiationCycle(pc);
  }

  await videoSender.replaceTrack(screenTrack);

  // Apply degradation preference to the new screen sender too
  const params = videoSender.getParameters();
  params.degradationPreference = "balanced";
  await videoSender.setParameters(params).catch(() => {
    /* non-fatal */
  });

  return { sender: videoSender, track: screenTrack };
}

/**
 * Restore the camera track (or null) on the previously captured screen sender.
 * Safe to call when no screen share is active — does nothing.
 */
export function stopScreenShare(
  sender: RTCRtpSender | null,
  cameraTrack: MediaStreamTrack | null,
): void {
  if (!sender) return;
  sender.replaceTrack(cameraTrack).catch(() => {
    /* non-fatal — sender may have been removed */
  });
}

/**
 * Wait for the current renegotiation cycle to finish.
 * Two-phase: first wait for state to leave "stable" (renegotiation began),
 * then wait for it to re-enter "stable" (renegotiation completed).
 */
function waitForNegotiationCycle(pc: RTCPeerConnection): Promise<void> {
  return new Promise<void>((resolve) => {
    const waitForStart = () => {
      if (pc.signalingState !== "stable") {
        const waitForEnd = () => {
          if (pc.signalingState === "stable") resolve();
          else setTimeout(waitForEnd, 50);
        };
        waitForEnd();
      } else {
        setTimeout(waitForStart, 20);
      }
    };
    setTimeout(waitForStart, 20);
  });
}
