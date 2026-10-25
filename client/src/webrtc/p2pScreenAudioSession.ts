import { SystemAudioCaptureSession } from "../audio/systemAudioCaptureSession";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";

export type P2PScreenAudioStatus = "off" | "starting" | "shared" | "not_returned" | "unavailable" | "ended";
export interface P2PScreenAudioController {
 canSendScreenAudio(): boolean;
 setLocalSource(sender: RTCRtpSender, source: "screen-audio" | null): void;
 waitUntilLocalSourceNegotiated(sender: RTCRtpSender, source: "screen-audio", current: () => boolean, timeoutMs?: number): Promise<boolean>;
}
type Options = { pc: RTCPeerConnection; sourceNonce: string; current: () => boolean; subscribeScope?: (changed: () => void) => () => void; controller: P2PScreenAudioController; state?: (status: P2PScreenAudioStatus) => void };
type Slot = { sender: RTCRtpSender; owner: P2PScreenAudioSession | null; tail: Promise<void> };
const slots = new WeakMap<RTCPeerConnection, Slot>();
const live = (track: MediaStreamTrack) => track.readyState === "live";

/** One dedicated, bounded sender per peer. Never borrows a microphone sender. */
export class P2PScreenAudioSession {
 private options: Options; private auth = JSON.stringify(getAuthSessionSnapshot());
 private stopped = false; private started = false; private raw: MediaStreamTrack | null = null;
 private native: SystemAudioCaptureSession | null = null; private slot: Slot | null = null;
 private cleanup: Array<() => void> = [];
 constructor(options: Options) {
  this.options = options;
  const retire = () => { if (!this.current()) this.stop(); };
  this.cleanup.push(subscribeAuthOwnerChanges(retire), subscribeAuthGenerationChanges(retire));
  if (options.subscribeScope) { const off = options.subscribeScope(retire); if (this.stopped) off(); else this.cleanup.push(off); }
 }
 private scopeCurrent() { try { return JSON.stringify(getAuthSessionSnapshot()) === this.auth && this.options.current() && this.options.pc.signalingState !== "closed"; } catch { return false; } }
 private current = () => !this.stopped && this.scopeCurrent() && this.options.controller.canSendScreenAudio();
 private notify(status: P2PScreenAudioStatus) { if (this.scopeCurrent()) this.options.state?.(status); }
 private async mutate(slot: Slot, current: () => boolean, mutation: () => Promise<void>) {
  const operation = slot.tail.catch(() => {}).then(async () => { if (!current()) return false; await mutation(); return current(); });
  slot.tail = operation.then(() => {}, () => {}); return operation;
 }
 private claim() {
  const pc = this.options.pc;
  let slot = slots.get(pc);
  if (!slot) { slot = { sender: pc.addTransceiver("audio", { direction: "sendonly" }).sender, owner: null, tail: Promise.resolve() }; slots.set(pc, slot); }
  slot.owner?.stop(); slot.owner = this; this.slot = slot; return slot;
 }
 private owns(slot: Slot, raw: MediaStreamTrack) { return this.current() && slot.owner === this && this.raw === raw && live(raw); }
 private finishFailed(slot: Slot, raw: MediaStreamTrack) { if (this.current() && slot.owner === this) this.fail(live(raw) ? "unavailable" : "ended"); else this.stop(); }
 private fail(status: P2PScreenAudioStatus) { this.stop(); this.notify(status); }
 async start({ native, browserTrack }: { native: boolean; browserTrack?: MediaStreamTrack | null }): Promise<boolean> {
  if (browserTrack) browserTrack.enabled = false;
  if (this.started || !this.current()) { browserTrack?.stop(); this.stop(); return false; }
  this.started = true; this.notify("starting");
  try {
   let raw = browserTrack ?? null;
   if (native) {
    browserTrack?.stop();
    const capture = new SystemAudioCaptureSession({ kind: "p2p", source: this.options.sourceNonce, current: this.current,
     subscribeCurrent: this.options.subscribeScope,
     state: state => { if (state.phase === "failed" && this.current()) this.fail("ended"); } });
    this.native = capture; raw = await capture.start();
   }
   if (!raw) { this.fail("not_returned"); return false; }
   raw.enabled = false;
   if (!this.current() || !live(raw) || raw.kind !== "audio") { raw.stop(); this.fail("unavailable"); return false; }
   this.raw = raw;
   const ended = () => { if (this.raw === raw && !this.stopped) this.fail("ended"); };
   raw.addEventListener("ended", ended, { once: true }); this.cleanup.push(() => raw.removeEventListener("ended", ended));
   const slot = this.claim(), owned = () => this.owns(slot, raw);
   if (!await this.mutate(slot, owned, () => slot.sender.replaceTrack(raw)) || slot.sender.track !== raw) { this.finishFailed(slot, raw); return false; }
   this.options.controller.setLocalSource(slot.sender, "screen-audio");
   if (!await this.mutate(slot, () => owned() && slot.sender.track === raw, async () => {
    const parameters = slot.sender.getParameters();
    if (parameters.encodings?.length) { parameters.encodings = parameters.encodings.map(encoding => ({ ...encoding, maxBitrate: 256000 })); await slot.sender.setParameters(parameters); }
   })) { this.finishFailed(slot, raw); return false; }
   const acknowledged = await this.options.controller.waitUntilLocalSourceNegotiated(slot.sender, "screen-audio", () => owned() && slot.sender.track === raw, 10000);
   if (!acknowledged || !owned() || slot.sender.track !== raw) { if (this.current()) this.fail("unavailable"); else this.stop(); return false; }
   raw.enabled = true; this.notify("shared"); return true;
  } catch { if (this.current()) this.fail("unavailable"); else this.stop(); return false; }
 }
 stop() {
  if (this.stopped) return; this.stopped = true;
  const raw = this.raw; this.raw = null; if (raw) { raw.enabled = false; raw.stop(); }
  this.native?.stop(); this.native = null; for (const off of this.cleanup) off(); this.cleanup = [];
  const slot = this.slot; this.slot = null;
  if (slot?.owner === this) {
   if (slot.sender.track === raw) this.options.controller.setLocalSource(slot.sender, null);
   slot.owner = null;
   if (raw) void this.mutate(slot, () => slot.owner === null && slot.sender.track === raw, () => slot.sender.replaceTrack(null)).catch(() => {});
  }
 }
}
