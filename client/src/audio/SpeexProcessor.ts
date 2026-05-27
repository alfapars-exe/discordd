import { Track } from "livekit-client";
import type { TrackProcessor, AudioProcessorOptions } from "livekit-client";
import { SpeexWorkletNode, loadSpeex } from "@sapphi-red/web-noise-suppressor";
import type { NoiseSuppressionLevel } from "../stores/slices/voiceSettingsSlice";

// Vite ?url imports resolved at build time for AudioWorklet
import speexWorkletPath from "@sapphi-red/web-noise-suppressor/speexWorklet.js?url";
import speexWasmPath from "@sapphi-red/web-noise-suppressor/speex.wasm?url";

/**
 * SpeexProcessor — Speex DSP noise suppression TrackProcessor.
 *
 * Pipeline: source -> gain -> speex -> destination
 *
 * Speex provides DSP-based noise reduction; we do not stack a VAD gate on top
 * (an extra energy gate caused the "Gürültü Azaltma açınca sesim gitmiyor"
 * silence bug — see RNNoiseProcessor for the same fix rationale).
 */

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
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  private initialInputVolume: number;

  // Constructor signature kept for backwards compat — micSensitivity and level
  // are accepted but ignored (Speex pipeline no longer has a downstream gate).
  constructor(
    _micSensitivity = 50,
    inputVolume = 100,
    _level: NoiseSuppressionLevel = "medium",
  ) {
    this.initialInputVolume = inputVolume;
  }

  /**
   * Builds the audio processing graph.
   * Pipeline: source -> gain -> speex -> destination
   */
  async init(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    const wasmBinary = await getWasmBinary();

    await ensureWorkletRegistered(audioContext, "speex", speexWorkletPath);

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

    this.destinationNode = audioContext.createMediaStreamDestination();

    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.speexNode);
    this.speexNode.connect(this.destinationNode);

    // LiveKit publishes this track instead of the original
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }

  /** Tears down and rebuilds the graph (e.g. on device change). */
  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  /** No-op — Speex pipeline has no downstream gate to retune. */
  setMicSensitivity(_sensitivity: number): void {
    // intentional no-op
  }

  /** No-op — Speex denoising strength is fixed; level no longer maps to a gate. */
  setNoiseSuppressionLevel(_level: NoiseSuppressionLevel): void {
    // intentional no-op
  }

  /** Updates input volume gain. 100 = unity, 200 = 2x amplification. */
  setInputVolume(volume: number): void {
    this.initialInputVolume = volume;
    if (this.gainNode) {
      this.gainNode.gain.value = volume / 100;
    }
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
      this.destinationNode?.disconnect();
    } catch {
      /* already disconnected */
    }

    this.sourceNode = null;
    this.gainNode = null;
    this.speexNode = null;
    this.destinationNode = null;
    this.processedTrack = undefined;
  }
}

export { SpeexProcessor };
