import { Track, type AudioProcessorOptions, type LocalAudioTrack, type TrackProcessor } from "livekit-client";
import { createMicrophonePipeline, type MicrophonePipeline } from "./microphonePipeline";
import { captureConstraints, type MicrophoneSettings } from "./microphoneSettings";
import { registerMicrophonePipeline } from "./pipelineStatus";
import { closeAudioContext } from "./audioOperation";

export class MicrophoneTrackProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "hichat-microphone-pipeline";
  processedTrack?: MediaStreamTrack;
  pipeline?: MicrophonePipeline;
  private abort = new AbortController();
  private unregister?: () => void;
  private active = false;
  private context: AudioContext;
  private unobserve?: () => void;
  private settings: MicrophoneSettings;
  private localTrack: LocalAudioTrack;
  constructor(settings: MicrophoneSettings, localTrack: LocalAudioTrack) {
    this.settings = settings;
    this.localTrack = localTrack;
    this.context = this.createContext();
    localTrack.setAudioContext(this.context);
  }
  private createContext() {
    try { return new AudioContext({ sampleRate: 48000, latencyHint: "interactive" }); }
    catch { return new AudioContext({ latencyHint: "interactive" }); }
  }

  async init(opts: AudioProcessorOptions) {
      const pipeline = await createMicrophonePipeline(opts.track, this.settings, {
        signal: this.abort.signal,
        audioContext: this.context,
        // SDK init/restart/destroy hold trackChangeLock. Graph operations must
        // never wait for that lock; persist capture policy separately below.
        applyCapture: (constraints) => opts.track.applyConstraints(constraints),
      });
      this.pipeline = pipeline;
      this.processedTrack = pipeline.processedTrack;
      this.processedTrack.enabled = !this.localTrack.isMuted;
      let previous = pipeline.getStatus().activeEngine;
      this.unobserve = pipeline.subscribe((status) => {
        if (previous === status.activeEngine || !status.activeEngine) return;
        previous = status.activeEngine;
        // Runtime fallback also updates SDK restart constraints, without tying
        // pipeline destruction to the SDK's lock.
        void this.localTrack.applyConstraints(captureConstraints(this.settings, status.activeEngine)).catch(() => {});
      });
      if (this.active) this.unregister = registerMicrophonePipeline(pipeline, "call");
  }
  activate() {
    this.active = true;
    if (this.pipeline && !this.unregister) this.unregister = registerMicrophonePipeline(this.pipeline, "call");
  }
  async update(settings: MicrophoneSettings) {
    this.settings = settings;
    await this.pipeline?.update(settings);
    if (this.pipeline && this.settings === settings) await this.localTrack.applyConstraints(captureConstraints(settings, this.pipeline.getStatus().activeEngine ?? "none"));
  }
  async restart(opts: AudioProcessorOptions) {
    this.unregister?.(); this.unregister = undefined;
    this.unobserve?.(); this.unobserve = undefined;
    await this.pipeline?.dispose();
    this.pipeline = undefined;
    this.processedTrack = undefined;
    this.context = this.createContext();
    // SDK restart holds trackChangeLock. setAudioContext would queue another
    // restart after this one, recursively rebuilding until stop races it.
    // Our graph owns its dedicated context independently of the SDK context.
    await this.init(opts);
    // The SDK calls restart while locked and without an AudioContext. Our graph
    // owns its context. Queue persistence without awaiting the same lock.
    const restored = this.pipeline as MicrophonePipeline | undefined;
    const constraints = captureConstraints(this.settings, restored?.getStatus().activeEngine ?? "none");
    void this.localTrack.applyConstraints(constraints).catch(() => {});
  }
  cancel() { this.abort.abort(); }
  async destroy() {
    this.abort.abort();
    this.unregister?.(); this.unregister = undefined;
    this.unobserve?.(); this.unobserve = undefined;
    await this.pipeline?.dispose();
    this.pipeline = undefined;
    this.processedTrack = undefined;
    await closeAudioContext(this.context);
  }
}
