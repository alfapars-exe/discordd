/**
 * RNNoiseProcessor — RNNoise WASM noise suppression TrackProcessor.
 *
 * Implements LiveKit's TrackProcessor<Track.Kind.Audio>.
 * Uses @sapphi-red/web-noise-suppressor for RNNoise WASM + AudioWorklet
 * to suppress mic noise (breath, keyboard, fan, AC).
 *
 * Audio pipeline:
 *   Mic Track -> MediaStreamSource -> GainNode -> RnnoiseWorkletNode -> MediaStreamDestination
 *                                                       |
 *                                                  RNNoise WASM
 *                                              (ML-based denoising +
 *                                               built-in VAD suppression)
 *
 * RNNoise has its own ML-based VAD that suppresses non-speech frames natively.
 * An additional energy-gate would double-gate the signal and silence quiet
 * talkers (root cause of the "Gürültü Azaltma açınca sesim gitmiyor" bug).
 * Gate-only behaviour is still available through VadGateProcessor when
 * noise reduction is disabled but sensitivity < 100.
 *
 * Lifecycle: init() -> restart() -> destroy()
 * Used via LocalAudioTrack.setProcessor(new RNNoiseProcessor()).
 */

import { Track } from "livekit-client";
import type { TrackProcessor, AudioProcessorOptions } from "livekit-client";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import type { NoiseSuppressionLevel } from "../stores/slices/voiceSettingsSlice";

// Re-export so legacy imports (e.g. VadGateProcessor) keep resolving;
// the canonical home is now ./gateConfig.
export { levelToThresholds } from "./gateConfig";

// Vite ?url imports — resolved at build time for AudioWorklet.addModule() and fetch()
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

/** WASM binary cache — shared across all processor instances (stateless). */
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;

function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = loadRnnoise({
      url: rnnoiseWasmPath,
      simdUrl: rnnoiseSimdWasmPath,
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

/**
 * Legacy: converts micSensitivity (0-100) to RMS threshold using a quadratic
 * curve. Kept exported for any external caller; the live RNNoise pipeline
 * no longer uses it (RNNoise has built-in VAD).
 */
export function sensitivityToThreshold(sensitivity: number): number {
  const clamped = Math.max(0, Math.min(100, sensitivity));
  const inverted = (100 - clamped) / 100;
  return 0.04 * inverted * inverted;
}

class RNNoiseProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = "rnnoise-noise-suppressor";
  processedTrack?: MediaStreamTrack;

  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private rnnoiseNode: RnnoiseWorkletNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  private initialInputVolume: number;

  // Constructor signature kept for backwards compat with useAudioProcessor —
  // micSensitivity and level are accepted but ignored (RNNoise's built-in
  // VAD handles speech detection; an extra gate caused the silence bug).
  constructor(
    _micSensitivity = 50,
    inputVolume = 100,
    _level: NoiseSuppressionLevel = "medium",
  ) {
    this.initialInputVolume = inputVolume;
  }

  /**
   * Builds the audio processing graph.
   * Pipeline: source -> gain -> rnnoise -> destination
   */
  async init(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    const wasmBinary = await getWasmBinary();

    await ensureWorkletRegistered(audioContext, "rnnoise", rnnoiseWorkletPath);

    const inputStream = new MediaStream([track]);
    this.sourceNode = audioContext.createMediaStreamSource(inputStream);

    // Input volume GainNode — applied before RNNoise processing
    this.gainNode = audioContext.createGain();
    this.gainNode.gain.value = this.initialInputVolume / 100;

    // maxChannels: 1 — mono mic input (stereo unnecessary, saves CPU)
    this.rnnoiseNode = new RnnoiseWorkletNode(audioContext, {
      wasmBinary,
      maxChannels: 1,
    });

    this.destinationNode = audioContext.createMediaStreamDestination();

    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.rnnoiseNode);
    this.rnnoiseNode.connect(this.destinationNode);

    // LiveKit publishes this track instead of the original
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }

  /** Tears down and rebuilds the graph (e.g. on device change). */
  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  /** No-op — RNNoise has built-in VAD, sensitivity is honoured by gate-only mode. */
  setMicSensitivity(_sensitivity: number): void {
    // intentional no-op
  }

  /** No-op — RNNoise denoising strength is fixed; level no longer maps to a gate. */
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
      this.rnnoiseNode?.disconnect();
      this.rnnoiseNode?.destroy();
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
    this.rnnoiseNode = null;
    this.destinationNode = null;
    this.processedTrack = undefined;
  }
}

export { RNNoiseProcessor };
