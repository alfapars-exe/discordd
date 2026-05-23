/**
 * VadGateProcessor — Standalone energy-based VAD gate TrackProcessor.
 *
 * Implements LiveKit's TrackProcessor<Track.Kind.Audio>.
 * Used when noise reduction is OFF but micSensitivity slider should still work.
 *
 * - NR ON  -> RNNoiseProcessor (ML denoising + VAD gate included)
 * - NR OFF -> VadGateProcessor (VAD gate only, no denoising)
 *
 * Pipeline: Mic Track -> MediaStreamSource -> VadGateNode -> MediaStreamDestination
 *
 * When micSensitivity is 100 (gate disabled), VoiceStateManager skips
 * applying this processor entirely to avoid unnecessary overhead.
 */

import { Track } from "livekit-client";
import type { TrackProcessor, AudioProcessorOptions } from "livekit-client";

import vadGateWorkletPath from "./vadGateWorklet.js?url";

/** AudioWorklet registration cache — prevents duplicate addModule() calls per AudioContext. */
const registeredContexts = new WeakMap<AudioContext, Promise<void>>();

function ensureWorkletRegistered(ctx: AudioContext): Promise<void> {
  let p = registeredContexts.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(vadGateWorkletPath);
    registeredContexts.set(ctx, p);
  }
  return p;
}

// Shared gate-config helper — same level/sensitivity curve and worklet
// message format as RNNoiseProcessor's gate path so behaviour is identical
// regardless of whether the denoiser is on. The cubic single-threshold curve
// in ./sensitivity.ts is the legacy path; the live pipeline routes through
// postGateConfigToWorklet/levelToThresholds for hysteresis-aware gating.
import { postGateConfigToWorklet } from "./gateConfig";
import type { NoiseSuppressionLevel } from "../stores/slices/voiceSettingsSlice";

class VadGateProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = "vad-gate-standalone";
  processedTrack?: MediaStreamTrack;

  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
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

  /** Builds the audio graph (VAD gate only, no ML denoising — much lighter than RNNoiseProcessor). */
  async init(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    await ensureWorkletRegistered(audioContext);

    const inputStream = new MediaStream([track]);
    this.sourceNode = audioContext.createMediaStreamSource(inputStream);

    // Input volume GainNode — applied before VAD gate processing.
    // Mono pinning mirrors RNNoiseProcessor: stereo mics with a silent
    // channel produce one-sided playback on remotes if the WebAudio
    // graph isn't collapsed at source.
    this.gainNode = audioContext.createGain();
    this.gainNode.gain.value = this.initialInputVolume / 100;
    this.gainNode.channelCount = 1;
    this.gainNode.channelCountMode = "explicit";
    this.gainNode.channelInterpretation = "speakers";

    this.vadGateNode = new AudioWorkletNode(audioContext, "vad-gate-processor", {
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    this.applyGateConfig();

    this.destinationNode = audioContext.createMediaStreamDestination();
    this.destinationNode.channelCount = 1;
    this.destinationNode.channelCountMode = "explicit";
    this.destinationNode.channelInterpretation = "speakers";

    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.vadGateNode);
    this.vadGateNode.connect(this.destinationNode);

    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  /** Updates VAD gate threshold. Same API as RNNoiseProcessor for uniform usage. */
  setMicSensitivity(sensitivity: number): void {
    this.initialSensitivity = sensitivity;
    this.applyGateConfig();
  }

  /** Updates noise-suppression level (recomputes hysteresis dB thresholds). */
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

  private applyGateConfig(): void {
    postGateConfigToWorklet(this.vadGateNode, this.initialLevel, this.initialSensitivity);
  }

  async destroy(): Promise<void> {
    try { this.sourceNode?.disconnect(); } catch { /* already disconnected */ }
    try { this.gainNode?.disconnect(); } catch { /* already disconnected */ }
    try { this.vadGateNode?.disconnect(); } catch { /* already disconnected */ }
    try { this.destinationNode?.disconnect(); } catch { /* already disconnected */ }

    this.sourceNode = null;
    this.gainNode = null;
    this.vadGateNode = null;
    this.destinationNode = null;
    this.processedTrack = undefined;
  }
}

export { VadGateProcessor };
