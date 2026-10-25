import {ManualVoiceSoundTracker} from "../utils/voiceEventSounds";
import {bindNativePTT,nativePTTAvailable}from "../audio/nativePTT";
import { createMicrophonePipeline, type MicrophonePipeline } from "../audio/microphonePipeline";
import { captureConstraints, microphoneSettings, settingsEqual, type MicrophoneSettings } from "../audio/microphoneSettings";
import { registerMicrophonePipeline } from "../audio/pipelineStatus";
import { DEFAULT_SETTINGS } from "../stores/slices/voiceSettingsSlice";
import { useVoiceStore } from "../stores/voiceStore";
import { useShortcutCaptureStore } from "../stores/shortcutCaptureStore";
import { getAuthSessionSnapshot, subscribeAuthGenerationChanges, subscribeAuthOwnerChanges } from "../api/authSessionEvents";

type Resource = { source: MediaStreamTrack; pipeline: MicrophonePipeline; settings: MicrophoneSettings };
type Options = {
  isCurrent: () => boolean;
  isMuted: () => boolean;
  manualMuted?: () => boolean;
  replaceTrack: (previous: MediaStreamTrack, next: MediaStreamTrack, isCurrent?: () => boolean) => Promise<boolean>;
  onError: (error: unknown) => void;
  commitTrack?: (previous:MediaStreamTrack,next:MediaStreamTrack)=>boolean;
  subscribeScope?: (retire: () => void) => () => void;
};
const settingsNow = () => microphoneSettings({ ...DEFAULT_SETTINGS, ...useVoiceStore.getState() });
const captureKey = (settings: MicrophoneSettings) => JSON.stringify([settings.inputDevice, settings.micProfile]);
const cancelled = () => new DOMException("P2P microphone operation cancelled", "AbortError");
const stopStream = (stream: MediaStream) => stream.getTracks().forEach(track => track.stop());
const editable = (target: EventTarget | null) => target instanceof Element && !!target.closest("input,textarea,select,[contenteditable],[role=textbox]");

/** One exact call owns raw capture, failure latch, focused PTT and processed output. */
export class P2PMicrophoneSession {
  private stopped = false;
  private soundState(){return {manualMuted:this.options.manualMuted?.()??this.options.isMuted(),deafened:useVoiceStore.getState().isDeafened};}
  private soundTracker:ManualVoiceSoundTracker;
  private failed = false;
  private retrying = false;
  private controller = new AbortController();
  private generation = 0;
  private pendingKey: string | null = null;
  private resource: Resource | null = null;
  private latest = settingsNow();
  private unsubscribe: (() => void) | null = null;
  private unregister: (() => void) | null = null;
  private captures = new Set<MediaStream>();
  private sourceListeners = new Map<MediaStreamTrack, () => void>();
  private staged = new Set<Resource>();
  private released = new WeakSet<Resource>();
  private commits: Promise<void> = Promise.resolve();
  private pressed = false;
  private pressedCode: string | null = null;
  private refreshNativePTT:(()=>void)|null=null;
  private controlsCleanup: (() => void) | null = null;
  private authCleanup: () => void;
  private scopeCleanup?: () => void;
  private readonly auth = JSON.stringify(getAuthSessionSnapshot());
  private readonly options: Options;
  constructor(options: Options) {
    this.options=options;
    this.soundTracker=new ManualVoiceSoundTracker(this.soundState(),()=>this.current());
    const retire = () => { if (JSON.stringify(getAuthSessionSnapshot()) !== this.auth) this.dispose(); };
    const owner = subscribeAuthOwnerChanges(retire), generation = subscribeAuthGenerationChanges(retire);
    this.authCleanup = () => { owner(); generation(); };
    this.scopeCleanup = options.subscribeScope?.(() => this.dispose());
  }
  get hasFailed() { return this.failed; }
  private current() { return !this.stopped && JSON.stringify(getAuthSessionSnapshot()) === this.auth && this.options.isCurrent(); }
  private enabled() {
    return this.current() && !this.failed && !this.options.isMuted()
      && (useVoiceStore.getState().inputMode !== "push_to_talk" || this.pressed);
  }
  private unlisten(source: MediaStreamTrack) {
    this.sourceListeners.get(source)?.(); this.sourceListeners.delete(source);
  }
  private release(resource: Resource) {
    if (this.released.has(resource)) return;
    this.released.add(resource); this.unlisten(resource.source);
    resource.pipeline.processedTrack.enabled = false;
    resource.source.stop(); resource.pipeline.processedTrack.stop();
    void resource.pipeline.dispose().catch(() => {});
  }
  private fail(error: unknown) {
    if (!this.current()) return;
    this.soundTracker.reject();this.failed = true;this.refreshNativePTT?.(); this.retrying = false; this.pressed = false; this.pressedCode = null;
    ++this.generation; this.controller.abort(); this.controller = new AbortController(); this.pendingKey = null;
    // Stop hardware and disable every possible sender output before notifying UI.
    if (this.resource) this.release(this.resource);
    for (const candidate of this.staged) { candidate.pipeline.processedTrack.enabled = false; this.unlisten(candidate.source); candidate.source.stop(); }
    for (const stream of this.captures) { for (const source of stream.getAudioTracks()) this.unlisten(source); stopStream(stream); }
    this.unregister?.(); this.unregister = null;
    this.options.onError(error);
  }
  private sourceEnded(source:MediaStreamTrack) {return source.readyState==="ended";}
  private watchSource(source: MediaStreamTrack) {
    const ended = () => {
      if (this.sourceListeners.has(source))
        this.fail(new DOMException("Microphone capture stopped", "NotReadableError"));
    };
    source.addEventListener?.("ended", ended);
    this.sourceListeners.set(source, () => source.removeEventListener?.("ended", ended));
    if (source.readyState === "ended") ended();
  }
  private async capture(settings: MicrophoneSettings, video: boolean | MediaTrackConstraints, signal: AbortSignal, valid: () => boolean) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: captureConstraints(settings), video });
    this.captures.add(stream);
    let pipeline: MicrophonePipeline | null = null, source: MediaStreamTrack | undefined;
    try {
      if (!this.current() || signal.aborted || !valid()) throw cancelled();
      source = stream.getAudioTracks()[0];
      if (!source) throw new Error("Microphone capture returned no audio track");
      this.watchSource(source);
      if (source.readyState === "ended" || signal.aborted || !valid()) throw cancelled();
      pipeline = await createMicrophonePipeline(source, settings, { signal });
      // Candidates stay silent until exact ownership commit; initial start gates below.
      pipeline.processedTrack.enabled = false;
      if (!this.current() || signal.aborted || !valid() || this.sourceEnded(source)) throw cancelled();
      return { resource: { source, pipeline, settings }, stream };
    } catch (error) {
      if (source) this.unlisten(source);
      if (pipeline) { pipeline.processedTrack.enabled = false; pipeline.processedTrack.stop(); await pipeline.dispose().catch(() => {}); }
      stopStream(stream); throw error;
    } finally { this.captures.delete(stream); }
  }
  async start(video: boolean | MediaTrackConstraints): Promise<MediaStream> {
    if (this.failed || !this.current()) throw cancelled();
    const id = this.generation, signal = this.controller.signal;
    try {
      const { resource, stream } = await this.capture(this.latest, video, signal, () => id === this.generation);
      if (!this.current() || this.failed || id !== this.generation) { this.release(resource); stream.getVideoTracks().forEach(track => track.stop()); throw cancelled(); }
      this.controller = new AbortController(); this.resource = resource;
      resource.pipeline.processedTrack.enabled = this.enabled();
      return new MediaStream([resource.pipeline.processedTrack, ...stream.getVideoTracks()]);
    } catch (error) { if (this.current() && !signal.aborted && id === this.generation) this.fail(error); throw error; }
  }
  connect() {
    if (!this.current() || !this.resource || this.unsubscribe) return;
    this.installControls(); this.syncMute();
    if (!this.failed) this.unregister = registerMicrophonePipeline(this.resource.pipeline, "call");
    let ptt = JSON.stringify([useVoiceStore.getState().inputMode, useVoiceStore.getState().pttKey]);
    this.unsubscribe = useVoiceStore.subscribe(() => {
      const nextPTT = JSON.stringify([useVoiceStore.getState().inputMode, useVoiceStore.getState().pttKey]);
      if (nextPTT !== ptt) { this.pressed = false; this.pressedCode = null; ptt = nextPTT; }
      this.refreshNativePTT?.();
      this.syncMute();
      const next = settingsNow();
      if (!settingsEqual(this.latest, next)) this.reconcile(next);
    });
    this.reconcile(settingsNow());
  }
  private installControls() {
    let nativeStop=()=>{},nativeConfig="",nativeWorks=false;
    const source=crypto.randomUUID();
    this.refreshNativePTT=()=>{
      const voice=useVoiceStore.getState(),desired=this.current()&&!this.failed&&nativePTTAvailable()&&voice.inputMode==="push_to_talk"&&!useShortcutCaptureStore.getState().active;
      const config=desired?voice.pttKey:"";if(config===nativeConfig)return;
      nativeStop();nativeConfig=config;nativeWorks=!!config;this.pressed=false;this.pressedCode=null;this.syncMute();
      if(config)nativeStop=bindNativePTT({kind:"p2p",source,keyCode:config,current:()=>this.current()&&!this.failed,onPressed:pressed=>{this.pressed=pressed;this.pressedCode=pressed?config:null;this.syncMute();},onUnavailable:()=>{if(this.current())this.fail(new DOMException("Global push-to-talk unavailable","NotSupportedError"));}});
    };
    const release = () => { if(nativeWorks)return;this.pressed = false; this.pressedCode = null; this.syncMute(); };
    const down = (event: KeyboardEvent) => {
      const voice = useVoiceStore.getState();
      if (nativeWorks || !this.current() || this.failed || voice.inputMode !== "push_to_talk" || event.code !== voice.pttKey || event.repeat
        || event.isComposing || document.hidden || !document.hasFocus() || editable(event.target) || editable(document.activeElement) || useShortcutCaptureStore.getState().active) return;
      this.pressed = true; this.pressedCode = event.code; this.syncMute();
    };
    const up = (event: KeyboardEvent) => { if (event.code === this.pressedCode || event.code === useVoiceStore.getState().pttKey) release(); };
    const visibility = () => { if (document.hidden) release(); };
    const focus = (event: FocusEvent) => { if (editable(event.target)) release(); };
    const composition = () => release();
    document.addEventListener("keydown", down); document.addEventListener("keyup", up); window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", visibility); document.addEventListener("focusin", focus); document.addEventListener("compositionstart", composition);
    const capture = useShortcutCaptureStore.subscribe(state=>{if(state.active)release();this.refreshNativePTT?.();});
    this.refreshNativePTT();
    this.controlsCleanup = () => {nativeStop();this.refreshNativePTT=null; capture(); document.removeEventListener("keydown", down); document.removeEventListener("keyup", up); window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", visibility); document.removeEventListener("focusin", focus); document.removeEventListener("compositionstart", composition); };
  }
  private reconcile(next: MicrophoneSettings) {
    if (!this.current() || !this.resource) return;
    this.latest = next;
    if(this.retrying){if(this.pendingKey!==captureKey(next))this.fail(new DOMException("Selected microphone changed during recovery","AbortError"));return;}
    if (this.failed) return;
    const key = captureKey(next);
    if (captureKey(this.resource.settings) === key) {
      if (this.pendingKey !== null) { ++this.generation; this.controller.abort(); this.controller = new AbortController(); this.pendingKey = null; }
      const resource = this.resource;
      void resource.pipeline.update(next).then(() => { if (this.current() && !this.failed && this.resource === resource) resource.settings = next; })
        .catch(error => { if (this.current() && this.resource === resource && !this.failed) this.fail(error); });
      return;
    }
    if (this.pendingKey !== key) void this.replace(next, false);
  }
  private async replace(next: MicrophoneSettings, recovering: boolean): Promise<boolean> {
    this.controller.abort(); this.controller = new AbortController();
    const signal = this.controller.signal, id = ++this.generation; this.pendingKey = captureKey(next);
    const valid = () => this.current() && id === this.generation && !signal.aborted && (!this.failed || recovering);
    let candidate: Resource | null = null;
    try {
      const captured = await this.capture(next, false, signal, valid); candidate = captured.resource; this.staged.add(candidate);
      this.controller = new AbortController();
      await candidate.pipeline.update(settingsNow());
      const resource = candidate;
      let committed = false;
      const commit = async () => {
        if (!valid() || !this.resource) return;
        const previous = this.resource;
        resource.pipeline.processedTrack.enabled = false;
        const attached = await this.options.replaceTrack(previous.pipeline.processedTrack, resource.pipeline.processedTrack, valid);
        if (!attached || !valid()) return;
        if(this.options.commitTrack?.(previous.pipeline.processedTrack,resource.pipeline.processedTrack)===false)return;
        if(!valid())return;
        this.resource = resource; this.staged.delete(resource); this.release(previous);
        if (recovering) this.failed = false;
        this.retrying = false; this.pendingKey = null;
        resource.pipeline.processedTrack.enabled = this.enabled();
        this.unregister?.(); this.unregister = registerMicrophonePipeline(resource.pipeline, "call"); committed = true;
      };
      this.commits = this.commits.catch(() => {}).then(commit); await this.commits;
      if (committed) {this.refreshNativePTT?.();this.reconcile(settingsNow());}
      return committed;
    } catch (error) {
      if (this.current() && id === this.generation && !signal.aborted) this.fail(error);
      return false;
    } finally { if (candidate && this.staged.delete(candidate)) this.release(candidate); if (id === this.generation) this.pendingKey = null; }
  }
  async retry(): Promise<boolean> {
    if (!this.current() || !this.failed || this.retrying || !this.resource) return false;
    this.retrying = true; this.latest = settingsNow();
    const result = await this.replace(this.latest, true);
    if (this.current()) this.retrying = false;
    return result;
  }
  syncMute() {
    if (!this.current()) return;
    this.soundTracker.observe(this.soundState());
    if(this.failed)this.soundTracker.reject();
    if(this.resource&&!this.failed&&this.sourceEnded(this.resource.source)){this.fail(new DOMException("Microphone capture stopped","NotReadableError"));return;}
    if (this.resource) this.resource.pipeline.processedTrack.enabled = this.enabled();
    if(this.resource&&!this.failed)this.soundTracker.commit(this.soundState(),this.resource.pipeline.processedTrack.enabled);
    // Never enable an output whose sender replacement has not committed.
    for (const candidate of this.staged) candidate.pipeline.processedTrack.enabled = false;
  }
  dispose() {
    if (this.stopped) return;
    this.stopped = true; ++this.generation; this.controller.abort(); this.unsubscribe?.(); this.unregister?.();
    this.authCleanup(); this.scopeCleanup?.(); this.controlsCleanup?.();
    this.unsubscribe = this.unregister = null;
    for (const stream of this.captures) { for (const source of stream.getAudioTracks()) this.unlisten(source); stopStream(stream); } this.captures.clear();
    for (const resource of this.staged) this.release(resource); this.staged.clear();
    if (this.resource) this.release(this.resource); this.resource = null;
    for (const remove of this.sourceListeners.values()) remove(); this.sourceListeners.clear();
  }
}
