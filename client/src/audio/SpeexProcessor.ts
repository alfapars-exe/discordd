import { Track } from "livekit-client";
import type { TrackProcessor, AudioProcessorOptions } from "livekit-client";
import { SpeexWorkletNode, loadSpeex } from "@sapphi-red/web-noise-suppressor";
import type { NoiseSuppressionLevel } from "../stores/slices/voiceSettingsSlice";
import { postGateConfigToWorklet } from "./gateConfig";

// Vite ?url imports resolved at build time for AudioWorklet
import speexWorkletPath from "@sapphi-red/web-noise-suppressor/speexWorklet.js?url";
import speexWasmPath from "@sapphi-red/web-noise-suppressor/speex.wasm?url";
import vadGateWorkletPath from "./vadGateWorklet.js?url";

/** WASM binary cache — shared across all processor instances (stateless). */
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;

function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = loadSpeex({
      url: speexWasmPath,
    });
  }
  return wasmBinaryPromise;
}

/**
 * AudioWorklet registration cache per AudioContext.
 * WeakMap so registration is GC'd with the AudioContext.
 */
const registeredContexts = new WeakMap<AudioContext, Map<string, Promise<void>>>();

function ensureWorkletRegistered(ctx: AudioContext, name: string, url: string): Promise<void> {
  let map = registeredContexts.get(ctx);
  if (!map) {
    map = new Map();
    registeredContexts.set(ctx, map);
  }
  let p = map.get(name);
  if (!p) {
    p = ctx.audioWorklet.addModule(url);
    map.set(name, p);
  }
  return p;
}

class SpeexProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = "speex-noise-suppressor";
  processedTrack?: MediaStreamTrack;

  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private speexNode: SpeexWorkletNode | null = null;
  private vadGateNode: AudioWorkletNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  private initialSensitivity: number;
  private initialInputVolume: number;
  private initialLevel: NoiseSuppressionLevel;

  constructor(
    micSensitivity = 50,
    inputVolume = 100,
    level: NoiseSuppressionLevel = "medium",
  ) {
    this.initialSensitivity = micSensitivity;
    this.initialInputVolume = inputVolume;
    this.initialLevel = level;
  }

  /**
   * Builds the audio processing graph.
   * Called by LiveKit: LocalAudioTrack.setProcessor() -> init().
   *
   * Pipeline: source -> speex -> vadGate -> destination
   */
  async init(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    const wasmBinary = await getWasmBinary();

    await Promise.all([
      ensureWorkletRegistered(audioContext, "speex", speexWorkletPath),
      ensureWorkletRegistered(audioContext, "vad-gate", vadGateWorkletPath),
    ]);

    const inputStream = new MediaStream([track]);
    this.sourceNode = audioContext.createMediaStreamSource(inputStream);

    // Input volume GainNode — applied before Speex processing
    this.gainNode = audioContext.createGain();
    this.gainNode.gain.value = this.initialInputVolume / 100;

    // maxChannels: 1 — mono mic input (stereo unnecessary, saves CPU)
    this.speexNode = new SpeexWorkletNode(audioContext, {
      wasmBinary,
      maxChannels: 1,
    });

    this.vadGateNode = new AudioWorkletNode(audioContext, "vad-gate-processor");
    this.applyGateConfig();

    this.destinationNode = audioContext.createMediaStreamDestination();

    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.speexNode);
    this.speexNode.connect(this.vadGateNode);
    this.vadGateNode.connect(this.destinationNode);

    // LiveKit publishes this track instead of the original
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }

  /** Tears down and rebuilds the graph (e.g. on device change). */
  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  /** Updates the VAD gate threshold. Safe to call when processor is inactive. */
  setMicSensitivity(sensitivity: number): void {
    this.initialSensitivity = sensitivity;
    this.applyGateConfig();
  }

  /** Updates the noise-suppression level (recomputes gate thresholds). */
  setNoiseSuppressionLevel(level: NoiseSuppressionLevel): void {
    this.initialLevel = level;
    this.applyGateConfig();
  }

  /** Updates input volume gain. 100 = unity, 200 = 2x amplification. */
  setInputVolume(volume: number): void {
    this.initialInputVolume = volume;
    if (this.gainNode) {
      this.gainNode.gain.value = volume / 100;
    }
  }

  /** Compute gate config from current level + sensitivity and post to worklet. */
  private applyGateConfig(): void {
    postGateConfigToWorklet(this.vadGateNode, this.initialLevel, this.initialSensitivity);
  }

  /** Disconnects all audio nodes and frees WASM memory. */
  async destroy(): Promise<void> {
    try {
      this.sourceNode?.disconnect();
    } catch {
      /* already disconnected */
    }

    try {
      this.gainNode?.disconnect();
    } catch {
      /* already disconnected */
    }

    try {
      this.speexNode?.disconnect();
      this.speexNode?.destroy();
    } catch {
      /* worklet already closed */
    }

    try {
      this.vadGateNode?.disconnect();
    } catch {
      /* already disconnected */
    }

    try {
      this.destinationNode?.disconnect();
    } catch {
      /* already disconnected */
    }

    this.sourceNode = null;
    this.gainNode = null;
    this.speexNode = null;
    this.vadGateNode = null;
    this.destinationNode = null;
    this.processedTrack = undefined;
  }
}

export { SpeexProcessor };
