import { createMicrophonePipeline, type MicrophonePipeline } from "../audio/microphonePipeline";
import { captureConstraints, microphoneSettings, settingsEqual, type MicrophoneSettings } from "../audio/microphoneSettings";
import { registerMicrophonePipeline } from "../audio/pipelineStatus";
import { DEFAULT_SETTINGS } from "../stores/slices/voiceSettingsSlice";
import { useVoiceStore } from "../stores/voiceStore";

type Resource = { source: MediaStreamTrack; pipeline: MicrophonePipeline; settings: MicrophoneSettings };
type Options = {
  isCurrent: () => boolean;
  isMuted: () => boolean;
  replaceTrack: (previous: MediaStreamTrack, next: MediaStreamTrack) => Promise<boolean>;
  onError: (error: unknown) => void;
};
const settingsNow = () => microphoneSettings({ ...DEFAULT_SETTINGS, ...useVoiceStore.getState() });
const captureKey = (settings: MicrophoneSettings) => JSON.stringify([settings.inputDevice, settings.micProfile]);
const cancelled = () => new DOMException("P2P microphone operation cancelled", "AbortError");
const stopStream = (stream: MediaStream) => stream.getTracks().forEach((track) => track.stop());

/** Owns one call's raw capture and processed output, independently of LiveKit. */
export class P2PMicrophoneSession {
  private readonly options: Options;
  private stopped = false;
  private controller = new AbortController();
  private generation = 0;
  private pendingKey: string | null = null;
  private resource: Resource | null = null;
  private latest = settingsNow();
  private unsubscribe: (() => void) | null = null;
  private unregister: (() => void) | null = null;
  private captures = new Set<MediaStream>();
  private staged = new Set<Resource>();
  private commits: Promise<void> = Promise.resolve();

  constructor(options: Options) { this.options = options; }
  private current() { return !this.stopped && this.options.isCurrent(); }
  private release(resource: Resource) {
    resource.source.stop();
    resource.pipeline.processedTrack.stop();
    void resource.pipeline.dispose().catch(() => {});
  }

  private async capture(settings: MicrophoneSettings, video: boolean | MediaTrackConstraints, signal: AbortSignal) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: captureConstraints(settings), video });
    this.captures.add(stream);
    let pipeline: MicrophonePipeline | null = null;
    try {
      if (!this.current() || signal.aborted) throw cancelled();
      const source = stream.getAudioTracks()[0];
      if (!source) throw new Error("Microphone capture returned no audio track");
      pipeline = await createMicrophonePipeline(source, settings, { signal });
      if (!this.current() || signal.aborted) throw cancelled();
      // The sender only ever receives this output after engine initialization.
      pipeline.processedTrack.enabled = !this.options.isMuted();
      return { resource: { source, pipeline, settings }, stream };
    } catch (error) {
      await pipeline?.dispose().catch(() => {});
      stopStream(stream);
      throw error;
    } finally {
      this.captures.delete(stream);
    }
  }

  async start(video: boolean | MediaTrackConstraints): Promise<MediaStream> {
    const { resource, stream } = await this.capture(this.latest, video, this.controller.signal);
    // Cleanup can run in a microtask between capture's last guard and this
    // continuation. Do not acquire ownership after the session was disposed.
    if (!this.current()) {
      this.release(resource);
      stream.getVideoTracks().forEach((track) => track.stop());
      throw cancelled();
    }
    // A pipeline's AbortSignal owns its lifetime. Subsequent acquisitions must
    // never abort the already-published pipeline while its replacement loads.
    this.controller = new AbortController();
    this.resource = resource;
    return new MediaStream([resource.pipeline.processedTrack, ...stream.getVideoTracks()]);
  }

  /** Subscribe after the store has attached the initial output to its peer. */
  connect() {
    if (!this.current() || !this.resource || this.unsubscribe) return;
    this.unregister = registerMicrophonePipeline(this.resource.pipeline, "call");
    this.unsubscribe = useVoiceStore.subscribe(() => {
      const next = settingsNow();
      if (!settingsEqual(this.latest, next)) this.reconcile(next);
    });
    this.reconcile(settingsNow());
  }

  private reconcile(next: MicrophoneSettings) {
    if (!this.current() || !this.resource) return;
    this.latest = next;
    const key = captureKey(next);
    if (captureKey(this.resource.settings) === key) {
      if (this.pendingKey !== null) {
        ++this.generation;
        this.controller.abort();
        this.controller = new AbortController();
        this.pendingKey = null;
      }
      const resource = this.resource;
      void resource.pipeline.update(next).then(() => {
        resource.settings = next;
      }).catch((error) => { if (this.current() && this.resource === resource) this.options.onError(error); });
      return;
    }
    if (this.pendingKey === key) return;
    this.controller.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const id = ++this.generation;
    this.pendingKey = key;
    void this.capture(next, false, signal).then(async ({ resource }) => {
      this.staged.add(resource);
      try {
        if (!this.current() || id !== this.generation) return;
        // The prepared candidate is now owned by staged/commits; disposing it
        // is deferred until a pending replaceTrack settles.
        this.controller = new AbortController();
        // Controls may have changed while capture/model initialization was pending.
        await resource.pipeline.update(this.latest);
        const commit = async () => {
          if (!this.current() || id !== this.generation || !this.resource) return;
          const previous = this.resource;
          resource.pipeline.processedTrack.enabled = !this.options.isMuted();
          const attached = await this.options.replaceTrack(previous.pipeline.processedTrack, resource.pipeline.processedTrack);
          if (!attached || !this.current()) return;
          resource.pipeline.processedTrack.enabled = !this.options.isMuted();
          this.resource = resource;
          this.staged.delete(resource);
          this.unregister?.();
          this.unregister = registerMicrophonePipeline(resource.pipeline, "call");
          this.release(previous);
          if (id === this.generation) this.pendingKey = null;
          // A setting may change during replaceTrack; converge after the commit.
          this.reconcile(this.latest);
        };
        this.commits = this.commits.catch(() => {}).then(commit);
        await this.commits;
      } finally {
        if (this.staged.delete(resource)) this.release(resource);
      }
    }).catch((error) => {
      if (this.current() && id === this.generation && !signal.aborted) this.options.onError(error);
    }).finally(() => {
      if (id === this.generation) this.pendingKey = null;
    });
  }

  dispose() {
    if (this.stopped) return;
    this.stopped = true;
    ++this.generation;
    this.controller.abort();
    this.unsubscribe?.();
    this.unregister?.();
    this.unsubscribe = this.unregister = null;
    for (const stream of this.captures) stopStream(stream);
    this.captures.clear();
    for (const resource of this.staged) this.release(resource);
    this.staged.clear();
    if (this.resource) this.release(this.resource);
    this.resource = null;
  }
}
