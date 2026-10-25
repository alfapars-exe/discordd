import { mutateOwnedVideoSender, replaceOwnedVideoTrack } from "./videoSenderMutation";
import { privateScreenConstraints, updatePrivateScreenQuality, type PrivateScreenQuality, type ScreenMetrics } from "../utils/privateScreenQuality";

const hasEnded = (track: MediaStreamTrack) => track.readyState === "ended";

export interface StartScreenShareResult { sender: RTCRtpSender; track: MediaStreamTrack; update: (settings: PrivateScreenQuality) => Promise<boolean>; dispose: () => void }
export type ScreenShareOptions = { isCurrent: () => boolean; settings: PrivateScreenQuality; display?: ScreenMetrics | null; getDisplayMetrics?: () => Promise<ScreenMetrics>; getCameraTrack?: () => MediaStreamTrack | null };

/** Own the picker result until the exact caller commits it. P2P shares video only. */
export async function startScreenShare(pc: RTCPeerConnection, options: ScreenShareOptions): Promise<StartScreenShareResult | null> {
  let stream: MediaStream | undefined;
  let disposed = false;
  let replacedSender: RTCRtpSender | undefined;
  let previousTrack: MediaStreamTrack | null = null;
  let capturedTrack: MediaStreamTrack | undefined;
  let display = options.display;
  const current = () => !disposed && options.isCurrent() && pc.signalingState !== "closed";
  const dispose = () => { disposed = true; stream?.getTracks().forEach(track => { track.enabled = false; track.stop(); }); };
  try {
    if (!current()) return null;
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: privateScreenConstraints(options.settings, options.display) });
    const track = stream.getVideoTracks()[0]; capturedTrack = track;
    if (!current() || !track || hasEnded(track)) { dispose(); return null; }
    stream.getTracks().filter(candidate => candidate !== track).forEach(candidate => candidate.stop());
    // Keep pending capture silent until replaceTrack and the current-session check finish.
    track.enabled = false;
    if (options.getDisplayMetrics) { try { display = await options.getDisplayMetrics(); } catch { /* Saved native choice uses the browser display fallback. */ } }
    if (!current()) { dispose(); return null; }
    let sender = pc.getSenders().find(candidate => candidate.track?.kind === "video")
      ?? pc.getTransceivers?.().find(transceiver => transceiver.receiver.track?.kind === "video" && transceiver.currentDirection !== "inactive" && !hasEnded(transceiver.receiver.track))?.sender;
    if (!sender) {
      sender = pc.addTransceiver("video", { direction: "sendrecv" }).sender;
      await waitForNegotiationCycle(pc, current);
    }
    if (!current()) { dispose(); return null; }
    previousTrack = sender.track; replacedSender = sender;
    await replaceOwnedVideoTrack(sender, track, current);
    if (!current() || hasEnded(track)) { dispose(); return null; }
    const ownedSender = sender;
    const sourceCurrent = () => current() && ownedSender.track === track;
    await updatePrivateScreenQuality(track, sender, options.settings, sourceCurrent, display);
    if (!sourceCurrent()) { dispose(); return null; }
    track.enabled = true;
    return { sender, track, dispose, update: settings => updatePrivateScreenQuality(track, ownedSender, settings, sourceCurrent, display) };
  } catch (error) {
    if (current() && replacedSender && replacedSender.track === capturedTrack) await stopScreenShare(replacedSender, options.getCameraTrack ? options.getCameraTrack() : previousTrack, current).catch(() => {});
    dispose(); if (options.isCurrent()) throw error; return null;
  }
}

export async function stopScreenShare(sender: RTCRtpSender | null, cameraTrack: MediaStreamTrack | null, isCurrent: () => boolean): Promise<boolean> {
  if (!sender) return false;
  const restored = await replaceOwnedVideoTrack(sender, cameraTrack, isCurrent);
  if (!restored) return false;
  return mutateOwnedVideoSender(sender, () => isCurrent() && sender.track === cameraTrack, async () => {
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    parameters.encodings = parameters.encodings.map(encoding => { const clean = { ...encoding }; delete clean.maxFramerate; delete clean.maxBitrate; return clean; });
    await sender.setParameters(parameters);
  });
}

/** A closed, replaced, or never-negotiated peer cannot retain an unbounded picker task. */
async function waitForNegotiationCycle(pc: RTCPeerConnection, current: () => boolean) {
  const deadline = Date.now() + 10_000;
  let began = pc.signalingState !== "stable";
  while (current() && Date.now() < deadline) {
    if (pc.signalingState !== "stable") began = true;
    else if (began) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new DOMException("Screen-share negotiation expired", "AbortError");
}
