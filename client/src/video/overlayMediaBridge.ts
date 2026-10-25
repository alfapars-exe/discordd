import { RemoteVideoTrack, Track } from "livekit-client";
import { parseOverlayMediaEnvelope, type OverlayICECandidate, type OverlayMediaEnvelope, type OverlayMediaSource, type OverlayVideoKind } from "../../../electron/overlay-media-contract";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";

export type OverlayMediaFailure = "unsupported" | "invalid" | "scope" | "source" | "timeout" | "transport";
type VideoAuthority = { tileId: string; kind: OverlayVideoKind; current: () => boolean; subscribeScope: (changed: () => void) => () => void };
export type OverlayAuthorizedVideo = VideoAuthority & ({ origin?: "livekit"; track: RemoteVideoTrack } | { origin: "p2p"; track: MediaStreamTrack });
const sourceRaw = (source: OverlayAuthorizedVideo) => source.origin === "p2p" ? source.track : source.track.mediaStreamTrack;
export type OverlayReceivedVideo = { tileId: string; kind: OverlayVideoKind; track: MediaStreamTrack };
type Options = { session: string; revision: number; current: () => boolean; subscribeScope: (changed: () => void) => () => void; send: (envelope: OverlayMediaEnvelope) => void; onError?: (failure: OverlayMediaFailure) => void };
export type OverlayMediaSenderOptions = Options & { sources: readonly OverlayAuthorizedVideo[] };
export type OverlayMediaReceiverOptions = Options & { onVideos: (videos: OverlayReceivedVideo[]) => void };
export type OverlayMediaBridge = { start(): Promise<boolean>; receive(raw: unknown): Promise<boolean>; dispose(): void; readonly ready: Promise<boolean> };
type CandidateEnvelope = Extract<OverlayMediaEnvelope, { kind: "candidate" }>;
type OwnedSource = { source: OverlayAuthorizedVideo; original: MediaStreamTrack; clone: MediaStreamTrack; sender: RTCRtpSender; transceiver: RTCRtpTransceiver };
const pendingLimit = 64;
class BridgeTimeout extends Error {}
const wait = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
 const finish = (done: () => void) => { clearTimeout(timer); signal.removeEventListener("abort", abort); done(); };
 const abort = () => finish(() => reject(new Error("retired")));
 const timer = setTimeout(() => finish(() => reject(new BridgeTimeout())), 10000);
 signal.addEventListener("abort", abort, { once: true }); operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error))); if (signal.aborted) abort();
});
/** One immutable source set per broker lease. Reconfiguration creates a new
 * session/revision; neither endpoint ever receives application media keys. */
class LocalVideoBridge implements OverlayMediaBridge {
 readonly ready: Promise<boolean>; private resolveReady!: (value: boolean) => void;
 private pc: RTCPeerConnection; private options: Options; private role: "sender" | "receiver"; private sources: readonly OverlayAuthorizedVideo[];
 private receiver?: (videos: OverlayReceivedVideo[]) => void; private auth = getAuthSessionSnapshot();
 private stopped = false; private started = false; private readyDone = false; private abort = new AbortController(); private cleanups: Array<() => void> = [];
 private clones = new Set<MediaStreamTrack>(); private owned: OwnedSource[] = []; private remoteTracks = new Map<RTCRtpTransceiver, MediaStreamTrack>(); private sourceMap = new Map<string, OverlayMediaSource>();
 private offerId: string | null = null; private localDescriptionId: string | null = null; private remoteDescriptionId: string | null = null; private descriptionReady = false; private staging = false; private descriptionSent = false;
 private outbound: CandidateEnvelope[] = []; private pending: CandidateEnvelope[] = []; private serial = Promise.resolve(); private timer: ReturnType<typeof setTimeout>;
 constructor(role: "sender" | "receiver", options: Options, sources: readonly OverlayAuthorizedVideo[], receiver?: (videos: OverlayReceivedVideo[]) => void) {
  this.role = role; this.options = { ...options }; this.sources = sources.map(source => ({ ...source })); this.receiver = receiver;
  this.ready = new Promise(resolve => { this.resolveReady = resolve; });
  this.pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
  this.pc.onicecandidate = event => this.localCandidate(event.candidate);
  this.pc.ontrack = event => this.onTrack(event);
  this.pc.onconnectionstatechange = () => { if (["failed", "closed", "disconnected"].includes(this.pc.connectionState)) this.fail("transport"); else this.connected(); };
  this.timer = setTimeout(() => this.fail("timeout"), 10000);
  const changed = () => { if (!this.current()) this.close("scope", true); };
  if (role === "sender") this.cleanups.push(subscribeAuthOwnerChanges(changed), subscribeAuthGenerationChanges(changed));
  try { const off = options.subscribeScope(changed); if (this.stopped) off(); else this.cleanups.push(off); } catch { this.close("scope", true); }
  if (!this.current()) this.close("scope", true);
 }
 private current() { try { const auth = getAuthSessionSnapshot(); return !this.stopped && this.options.current() && (this.role !== "sender" || !!this.auth.ownerId && auth.ownerId === this.auth.ownerId && auth.generation === this.auth.generation); } catch { return false; } }
 private sourceCurrent(owned: OwnedSource) { try { return this.current() && owned.source.current() && sourceRaw(owned.source) === owned.original && owned.original.readyState === "live" && owned.clone.readyState === "live"; } catch { return false; } }
 private base() { return { protocol: 1 as const, session: this.options.session, revision: this.options.revision }; }
 private send(envelope: OverlayMediaEnvelope) { if (!this.current() || !parseOverlayMediaEnvelope(envelope)) throw new Error("invalid"); this.options.send(envelope); }
 private enqueue(operation: () => Promise<boolean>) { const task = this.serial.catch(() => {}).then(operation); this.serial = task.then(() => {}, () => {}); return task.catch(error => { if (!this.stopped) this.fail(error instanceof BridgeTimeout ? "timeout" : "transport"); return false; }); }
 async start() { if (this.role !== "sender" || this.started || !this.current()) return false; this.started = true;
  return this.enqueue(async () => {
   if (!this.current() || !this.sources.length || this.sources.length > 4) { this.fail("source"); return false; }
   this.offerId = crypto.randomUUID(); this.localDescriptionId = this.offerId;
   for (const source of this.sources) {
    if (!this.current() || (source.origin !== "p2p" && (!(source.track instanceof RemoteVideoTrack) || source.track.isLocal || source.track.source !== (source.kind === "camera" ? Track.Source.Camera : Track.Source.ScreenShare))) || !source.current()) { this.fail("source"); return false; }
    const original = sourceRaw(source); if (original.kind !== "video" || original.readyState !== "live") { this.fail("source"); return false; }
    const clone = original.clone(); if (clone === original) { this.fail("source"); return false; } this.clones.add(clone); clone.enabled = false;
    if (clone.kind !== "video" || clone.readyState !== "live") { this.fail("source"); return false; }
    const settings = original.getSettings();
    const scale = Math.max(1, (settings.width ?? 0) / 1920, (settings.height ?? 0) / 1080);
    const transceiver = this.pc.addTransceiver(clone, { direction: "sendonly", sendEncodings: [{ maxBitrate: 2500000, maxFramerate: 60, scaleResolutionDownBy: scale }] });
    const owned = { source, original, clone, sender: transceiver.sender, transceiver }; this.owned.push(owned);
    const retire = () => { if (!this.sourceCurrent(owned)) this.close("source", true); };
    const off = source.subscribeScope(retire); if (this.stopped) { off(); return false; } this.cleanups.push(off);
    original.addEventListener("ended", retire); this.cleanups.push(() => original.removeEventListener("ended", retire));
    if (!this.sourceCurrent(owned)) { this.close("source", true); return false; }
   }
   const offer = await wait(this.pc.createOffer(), this.abort.signal); if (!this.current()) return false;
   await wait(this.pc.setLocalDescription(offer), this.abort.signal); if (!this.current() || this.owned.some(value => !this.sourceCurrent(value))) { this.close("source", true); return false; }
   const sources = this.owned.map(value => ({ mid: value.transceiver.mid ?? "", tileId: value.source.tileId, kind: value.source.kind }));
   this.send({ ...this.base(), kind: "offer", descriptionId: this.offerId!, sdp: offer.sdp ?? "", sources }); this.descriptionSent = true; this.flushOutbound(); return this.current();
  });
 }
 receive(raw: unknown): Promise<boolean> {
  const envelope = parseOverlayMediaEnvelope(raw);
  if (!envelope) { if (raw && typeof raw === "object" && "session" in raw && raw.session !== this.options.session) return Promise.resolve(false); this.fail("invalid"); return Promise.resolve(false); }
  if (!this.current() || envelope.session !== this.options.session || envelope.revision !== this.options.revision) return Promise.resolve(false);
  if (envelope.kind === "end") { this.close(envelope.reason, false); return Promise.resolve(true); }
  return this.enqueue(async () => {
   if (!this.current()) return false;
   if (envelope.kind === "candidate") {
    if (this.offerId && envelope.offerId !== this.offerId || this.remoteDescriptionId && envelope.descriptionId !== this.remoteDescriptionId) return false;
    if (!this.descriptionReady || !this.remoteDescriptionId) { if (this.pending.length >= pendingLimit) { this.fail("invalid"); return false; } this.pending.push(envelope); return true; }
    await wait(this.pc.addIceCandidate(envelope.candidate), this.abort.signal); return this.current();
   }
   if (this.role === "receiver" && envelope.kind === "offer" && !this.started) {
    this.started = true; this.offerId = envelope.descriptionId; this.remoteDescriptionId = envelope.descriptionId; this.localDescriptionId = crypto.randomUUID(); this.sourceMap = new Map(envelope.sources.map(value => [value.mid, value]));
    this.staging = true; await wait(this.pc.setRemoteDescription({ type: "offer", sdp: envelope.sdp }), this.abort.signal); if (!this.current()) return false;
    const answer = await wait(this.pc.createAnswer(), this.abort.signal); if (!this.current()) return false;
    await wait(this.pc.setLocalDescription(answer), this.abort.signal); if (!this.current()) return false;
    this.send({ ...this.base(), kind: "answer", descriptionId: this.localDescriptionId!, replyTo: this.offerId!, sdp: answer.sdp ?? "" }); this.descriptionSent = true; this.descriptionReady = true; this.staging = false;
    await this.flushPending(); if (!this.current()) return false; this.flushOutbound(); this.publish(); this.connected(); return true;
   }
   if (this.role === "sender" && envelope.kind === "answer" && this.offerId && envelope.replyTo === this.offerId && !this.remoteDescriptionId) {
    this.remoteDescriptionId = envelope.descriptionId;
    await wait(this.pc.setRemoteDescription({ type: "answer", sdp: envelope.sdp }), this.abort.signal); if (!this.current() || this.owned.some(value => !this.sourceCurrent(value))) { this.close("source", true); return false; }
    this.descriptionReady = true; await this.flushPending(); this.connected(); return this.current();
   }
   return false;
  });
 }
 private localCandidate(candidate: RTCIceCandidate | null) {
  if (!candidate || !this.current() || !this.offerId || !this.localDescriptionId) return;
  const data = candidate.toJSON(); const envelope = { ...this.base(), kind: "candidate" as const, offerId: this.offerId, descriptionId: this.localDescriptionId, candidate: { candidate: data.candidate ?? "", sdpMid: data.sdpMid ?? null, sdpMLineIndex: data.sdpMLineIndex ?? null, ...(data.usernameFragment !== undefined ? { usernameFragment: data.usernameFragment } : {}) } as OverlayICECandidate };
  // Public/relay candidates are never relayed, even when a host has a public interface.
  if (!parseOverlayMediaEnvelope(envelope)) return;
  if (!this.descriptionSent) { if (this.outbound.length < pendingLimit) this.outbound.push(envelope); return; }
  try { this.send(envelope); } catch { this.fail("transport"); }
 }
 private flushOutbound() { const pending = this.outbound; this.outbound = []; for (const envelope of pending) { if (!this.current()) return; this.send(envelope); } }
 private async flushPending() { const pending = this.pending; this.pending = []; for (const envelope of pending) { if (!this.current()) return; if (envelope.offerId === this.offerId && envelope.descriptionId === this.remoteDescriptionId) await wait(this.pc.addIceCandidate(envelope.candidate), this.abort.signal); } }
 private onTrack(event: RTCTrackEvent) {
  if (!this.pc.getTransceivers().includes(event.transceiver) || event.transceiver.receiver.track !== event.track) return;
  event.track.enabled = false;
  if (this.role !== "receiver" || !this.current() || event.track.kind !== "video" || !this.pc.getTransceivers().includes(event.transceiver) || event.transceiver.receiver.track !== event.track) { event.track.stop(); return; }
  const previous = this.remoteTracks.get(event.transceiver);
  if (previous === event.track) return;
  if (previous) { event.track.stop(); this.fail("invalid"); return; }
  this.remoteTracks.set(event.transceiver, event.track);
  const ended = () => { if (this.remoteTracks.get(event.transceiver) === event.track) { this.remoteTracks.delete(event.transceiver); this.publish(); } };
  event.track.addEventListener("ended", ended); this.cleanups.push(() => event.track.removeEventListener("ended", ended));
  if (!this.staging && this.descriptionReady) this.publish();
 }
 private publish() {
  if (this.role !== "receiver" || !this.current() || this.staging || !this.descriptionReady) return;
  const videos: OverlayReceivedVideo[] = [];
  for (const [transceiver, track] of this.remoteTracks) {
   const source = this.sourceMap.get(transceiver.mid ?? "");
   if (!source || track.readyState !== "live" || transceiver.currentDirection !== "recvonly" || transceiver.receiver.track !== track || !this.pc.getTransceivers().includes(transceiver)) { track.enabled = false; track.stop(); this.remoteTracks.delete(transceiver); continue; }
   track.enabled = this.readyDone && this.pc.connectionState === "connected"; videos.push({ tileId: source.tileId, kind: source.kind, track });
  }
  try { this.receiver?.(videos); } catch { this.fail("transport"); }
 }
 private connected() {
  if (!this.current() || !this.descriptionReady || this.pc.connectionState !== "connected") return;
  if (this.owned.some(value => !this.sourceCurrent(value))) { this.close("source", true); return; }
  clearTimeout(this.timer); this.readyDone = true; for (const owned of this.owned) owned.clone.enabled = true; this.publish(); this.resolveReady(true);
 }
 private fail(failure: OverlayMediaFailure) { if (this.stopped) return; this.close(failure === "source" || failure === "scope" ? failure : "error", true); try { this.options.onError?.(failure); } catch { /* Never expose transport payloads through observer errors. */ } }
 private close(reason: "closed" | "scope" | "source" | "error", notify: boolean) {
  if (this.stopped) return; this.stopped = true; clearTimeout(this.timer); this.abort.abort();
  const cleanups = this.cleanups; this.cleanups = []; for (const off of cleanups) { try { off(); } catch { /* Continue exact-owner cleanup. */ } }
  for (const clone of this.clones) { clone.enabled = false; clone.stop(); } this.clones.clear(); this.owned = [];
  for (const track of this.remoteTracks.values()) { track.enabled = false; track.stop(); } this.remoteTracks.clear(); this.pending = []; this.outbound = []; this.sourceMap.clear();
  this.pc.ontrack = null; this.pc.onicecandidate = null; this.pc.onconnectionstatechange = null; this.pc.close();
  try { this.receiver?.([]); } catch { /* Clear observers cannot retain a transport. */ }
  this.resolveReady(false);
  if (notify) { try { this.options.send({ ...this.base(), kind: "end", reason }); } catch { /* Scoped peer may already be retired. */ } }
 }
 dispose() { this.close("closed", true); }
}
function create(role: "sender" | "receiver", options: Options, sources: readonly OverlayAuthorizedVideo[], receiver?: (videos: OverlayReceivedVideo[]) => void): OverlayMediaBridge | null {
 if (!parseOverlayMediaEnvelope({ protocol: 1, session: options.session, revision: options.revision, kind: "end", reason: "closed" })) { options.onError?.("invalid"); return null; }
 try { return new LocalVideoBridge(role, options, sources, receiver); } catch { options.onError?.("unsupported"); return null; }
}
export const createOverlayMediaSender = (options: OverlayMediaSenderOptions) => create("sender", options, options.sources);
export const createOverlayMediaReceiver = (options: OverlayMediaReceiverOptions) => create("receiver", options, [], options.onVideos);
