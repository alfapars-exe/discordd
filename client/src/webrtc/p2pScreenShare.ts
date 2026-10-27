import { isElectron } from "../utils/constants";
import { mutateOwnedVideoSender, replaceOwnedVideoTrack } from "./videoSenderMutation";
import { privateScreenConstraints, updatePrivateScreenQuality, type PrivateScreenQuality, type ScreenMetrics } from "../utils/privateScreenQuality";
import { resolveScreenSharePublishDefaults } from "../utils/screenShareProfile";
import { P2PScreenCodecPolicy } from "./p2pScreenCodec";

const hasEnded = (track: MediaStreamTrack) => track.readyState === "ended";
type CameraPolicy = { owner: MediaStreamTrack; encodings: RTCRtpEncodingParameters[]; degradation: RTCDegradationPreference | undefined; codec: P2PScreenCodecPolicy };
const cameraPolicies = new WeakMap<RTCRtpSender, CameraPolicy>();

export interface StartScreenShareResult { sender: RTCRtpSender; track: MediaStreamTrack; audioTrack: MediaStreamTrack | null; update: (settings: PrivateScreenQuality) => Promise<boolean>; dispose: () => void }
export type ScreenShareOptions = { audioRequested?: boolean; audioCurrent?: () => boolean; restoreCurrent?: () => boolean; subscribeScope?: (retire: () => void) => () => void; subscribeAudioScope?: (retire: () => void) => () => void; isCurrent: () => boolean; settings: PrivateScreenQuality; display?: ScreenMetrics | null; getDisplayMetrics?: () => Promise<ScreenMetrics>; getCameraTrack?: () => MediaStreamTrack | null };

/** Own the picker result until the exact caller commits it. Audio remains disabled until the separate source-ACK publisher admits it. */
export async function startScreenShare(pc: RTCPeerConnection, options: ScreenShareOptions): Promise<StartScreenShareResult | null> {
  let stream: MediaStream | undefined;
  let disposed = false;
  let replacedSender: RTCRtpSender | undefined;
  let previousTrack: MediaStreamTrack | null = null;
  let capturedTrack: MediaStreamTrack | undefined;
  let display = options.display;
  let audioTrack: MediaStreamTrack | null = null, audioRetired = false;
  let scopeOff: (() => void) | null = null, audioOff: (() => void) | null = null;
  const stoppedTracks = new WeakSet<MediaStreamTrack>();
  const stopTrack = (track: MediaStreamTrack) => { track.enabled = false; if (!stoppedTracks.has(track)) { stoppedTracks.add(track); track.stop(); } };
  const current = () => !disposed && options.isCurrent() && pc.signalingState !== "closed";
  const audioCurrent = () => !audioRetired && current() && (!options.audioCurrent || options.audioCurrent());
  // Repeated disposal still observes a late picker result. Tracks themselves
  // stop once; an already-disposed flag must never orphan later GDM output.
  const dispose = () => { disposed = true; stream?.getTracks().forEach(stopTrack); audioTrack = null; const off = scopeOff; scopeOff = null; const offAudio = audioOff; audioOff = null; off?.(); offAudio?.(); };
  const retireAudio = () => { if (audioCurrent()) return; audioRetired = true; if (audioTrack) stopTrack(audioTrack); audioTrack = null; const off = audioOff; audioOff = null; off?.(); };
  const restoreCancelled = async () => {
    const sender = replacedSender, ownedRaw = capturedTrack;
    if (!sender || !ownedRaw || sender.track !== ownedRaw) return;
    const restoreScope = () => pc.signalingState !== "closed" && (options.isCurrent() || options.restoreCurrent?.() === true);
    let expected: MediaStreamTrack | null = ownedRaw;
    while (restoreScope() && sender.track === expected) {
      const selected = options.getCameraTrack ? options.getCameraTrack() : previousTrack;
      const camera = selected && !hasEnded(selected) ? selected : null;
      const restored = await stopScreenShare(sender, camera, () => restoreScope() && (sender.track === expected || sender.track === camera));
      if (!restored || !restoreScope() || sender.track !== camera) return;
      const latest = options.getCameraTrack ? options.getCameraTrack() : previousTrack;
      if ((latest && !hasEnded(latest) ? latest : null) === camera) return;
      expected = camera;
    }
  };
  try {
    if (!current()) return null;
    if (options.subscribeScope) { const off = options.subscribeScope(() => { if (!current()) dispose(); }); if (disposed) off(); else scopeOff = off; }
    if (options.subscribeAudioScope) { const off = options.subscribeAudioScope(retireAudio); if (disposed || audioRetired) off(); else audioOff = off; }
    if (!current()) { dispose(); return null; }
    const captureAudio = options.audioRequested === true && !isElectron() && audioCurrent();
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: captureAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } : false, video: privateScreenConstraints(options.settings, options.display) });
    audioTrack = captureAudio ? stream.getTracks().find(candidate => candidate.kind === "audio") ?? null : null;
    // The picker may return an enabled system source. Silence it before any
    // further await, even while video replacement/quality configuration waits.
    if (audioTrack) audioTrack.enabled = false;
    retireAudio();
    const track = stream.getVideoTracks()[0]; capturedTrack = track;
    if (!current() || !track || hasEnded(track)) { dispose(); return null; }
    stream.getTracks().filter(candidate => candidate !== track && candidate !== audioTrack).forEach(stopTrack);
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
    const original = sender.getParameters();
    const inherited = cameraPolicies.get(sender);
    const codec = inherited?.owner === previousTrack ? inherited.codec : new P2PScreenCodecPolicy(pc, sender);
    await replaceOwnedVideoTrack(sender, track, current);
    if (!current() || hasEnded(track)) { dispose(); await restoreCancelled().catch(() => {}); return null; }
    const ownedSender = sender;
    const sourceCurrent = () => current() && ownedSender.track === track;
    cameraPolicies.set(sender, { owner: track, codec, encodings: inherited?.owner === previousTrack ? inherited.encodings : original.encodings?.map(value => ({ ...value })) ?? [], degradation: inherited?.owner === previousTrack ? inherited.degradation : original.degradationPreference });
    let revision = 0, applied: PrivateScreenQuality | undefined;
    let updates = Promise.resolve(false);
    const update = (settings: PrivateScreenQuality) => {
      const choice = { ...settings }, selectedRevision = ++revision;
      const selectedCurrent = () => sourceCurrent() && selectedRevision === revision;
      updates = updates.catch(() => false).then(async () => {
        if (!selectedCurrent()) return false;
        const previous = applied;
        try {
          const profile = resolveScreenSharePublishDefaults(choice, display);
          if (!await codec.apply(profile.screenSharePublish.videoCodec, choice.screenShareLowLatency === true, selectedCurrent)) return false;
          if (!selectedCurrent()) return false;
          const updated = await updatePrivateScreenQuality(track, ownedSender, choice, selectedCurrent, display);
          if (updated) applied = choice;
          return updated;
        } catch (error) {
          if (selectedCurrent() && previous) {
            const previousProfile = resolveScreenSharePublishDefaults(previous, display);
            await codec.apply(previousProfile.screenSharePublish.videoCodec, false, selectedCurrent).catch(() => {});
            if (selectedCurrent()) await updatePrivateScreenQuality(track, ownedSender, previous, selectedCurrent, display).catch(() => {});
          }
          throw error;
        }
      });
      return updates;
    };
    await update(options.settings);
    if (!sourceCurrent()) { dispose(); await restoreCancelled().catch(() => {}); return null; }
    track.enabled = true;
    return { sender, track, get audioTrack() { return audioCurrent() && audioTrack && !hasEnded(audioTrack) ? audioTrack : null; }, dispose, update };
  } catch (error) {
    dispose(); await restoreCancelled().catch(() => {}); if (options.isCurrent()) throw error; return null;
  }
}

export async function stopScreenShare(sender: RTCRtpSender | null, cameraTrack: MediaStreamTrack | null, isCurrent: () => boolean): Promise<boolean> {
  if (!sender) return false;
  const policy = cameraPolicies.get(sender);
  const restored = await replaceOwnedVideoTrack(sender, cameraTrack, isCurrent);
  if (!restored) return false;
  const owns = () => isCurrent() && sender.track === cameraTrack;
  const updated = await mutateOwnedVideoSender(sender, owns, async () => {
    const parameters = sender.getParameters();
    if (policy) parameters.degradationPreference = policy.degradation ?? "balanced";
    parameters.encodings = parameters.encodings?.map((encoding, index) => {
      const clean = { ...encoding };
      delete clean.maxFramerate; delete clean.maxBitrate;
      const original = policy?.encodings[index];
      if (original?.maxFramerate !== undefined) clean.maxFramerate = original.maxFramerate;
      if (original?.maxBitrate !== undefined) clean.maxBitrate = original.maxBitrate;
      return clean;
    });
    await sender.setParameters(parameters);
  });
  if (!updated) return false;
  if (policy && !await policy.codec.restore(owns)) return false;
  if (owns() && cameraPolicies.get(sender) === policy) cameraPolicies.delete(sender);
  return owns();
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
