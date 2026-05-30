/**
 * DtlnProcessor — Real DTLN (Dual-signal Transformation LSTM Network) noise
 * suppression TrackProcessor, NOT a sneaky DeepFilterNet3 alias.
 *
 * DTLN runs natively at 16 kHz (see @sapphi-red/dtln-web `sampleRate`), so
 * we spin up a dedicated AudioContext at 16 kHz. The browser resamples the
 * incoming 48 kHz mic track to 16 kHz when `createMediaStreamSource` reads
 * it — no manual resampling needed. Output is a 16 kHz MediaStreamTrack
 * which WebRTC/LiveKit will encode through Opus (whose internal SR is
 * 48 kHz anyway), so the SR mismatch is invisible to remote listeners.
 *
 * Pipeline:
 *   Mic Track (48 kHz) -> MediaStreamSource (browser resamples to 16 kHz)
 *     -> DTLN ScriptProcessorNode (TFLite inference per 256-sample frame)
 *     -> MediaStreamDestination (16 kHz mono)
 *     -> processedTrack -> LiveKit publish (Opus 48 kHz encode)
 *
 * Model + WASM are loaded once globally (TF.js + TFLite WASM) and cached
 * via an idempotent setup promise; multiple processor instances share the
 * same model in memory.
 *
 * Assets live in /public/dtln/ (copied from @sapphi-red/dtln-web/dist
 * because TFLite SDK uses URL-based path resolution rather than Vite
 * `?url` imports).
 *
 * Note: ScriptProcessorNode is deprecated but still supported — DTLN-web
 * upstream hasn't migrated to AudioWorklet yet. Acceptable trade-off for
 * now; revisit if browsers signal removal.
 */

import { Track } from "livekit-client";
import type { TrackProcessor, AudioProcessorOptions } from "livekit-client";
import {
  setup as setupDtln,
  loadModel as loadDtlnModel,
  createDtlnProcessorNode,
  sampleRate as DTLN_SAMPLE_RATE,
} from "@sapphi-red/dtln-web";
import { isNativeApp } from "../utils/constants";
import { resolvePublicAssetBase } from "./publicAssetBase";

let dtlnReadyPromise: Promise<void> | null = null;

/**
 * Lazy global setup: load TFLite WASM + DTLN models once, share across
 * every processor instance. Errors are surfaced to the caller so the
 * useAudioProcessor branch can fall back to RNNoise on init failure.
 */
function ensureDtlnReady(): Promise<void> {
  if (!dtlnReadyPromise) {
    dtlnReadyPromise = (async () => {
      // Web → "/dtln/" (origin-absolute, route-independent); native (Electron
      // file://, Capacitor) → "./dtln/" relative to index.html. A hardcoded
      // "/dtln/" 404s on native (filesystem/scheme root) → ensureDtlnReady
      // throws → silent RNNoise fallback. Same web/native gotcha as DeepFilter,
      // opposite sign — see resolvePublicAssetBase.
      const base = `${resolvePublicAssetBase("dtln", isNativeApp(), import.meta.env.BASE_URL)}/`;
      await setupDtln(`${base}tflite_web_api_cc_simd.wasm`);
      await loadDtlnModel({ path: base, quant: "f16" });
    })().catch((err) => {
      // Reset on failure so a retry (user re-toggling the engine) re-attempts.
      dtlnReadyPromise = null;
      throw err;
    });
  }
  return dtlnReadyPromise;
}

class DtlnProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = "dtln-noise-suppressor";
  processedTrack?: MediaStreamTrack;

  private ownContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private dtlnNode: ScriptProcessorNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  // Constructor signature mirrors RNNoise/Speex for caller polymorphism in
  // useAudioProcessor. None of the three values are honoured here:
  // micSensitivity → DTLN has built-in suppression behaviour, sensitivity
  //                  is a gate-only concept that doesn't apply.
  // inputVolume    → no pre-network gain node (would re-quantize at 16 kHz
  //                  and fight the WebRTC encoder's gain control).
  // level          → DTLN model strength is fixed; not run-time tunable.
  constructor(
    _micSensitivity = 50,
    _inputVolume = 100,
    _level: unknown = undefined,
  ) {
    // intentional no-op body — see comment above
  }

  /**
   * Build the 16 kHz processing graph. Browser handles the 48→16
   * resample for us when createMediaStreamSource pulls from the
   * incoming MediaStreamTrack.
   */
  async init(opts: AudioProcessorOptions): Promise<void> {
    const { track } = opts;
    await ensureDtlnReady();

    // Dedicated 16 kHz context. We deliberately ignore opts.audioContext
    // (typically 48 kHz) — DTLN's TFLite model is hardcoded to 16 kHz
    // frames so feeding it 48 kHz would silently corrupt inference.
    this.ownContext = new AudioContext({ sampleRate: DTLN_SAMPLE_RATE });

    const inputStream = new MediaStream([track]);
    this.sourceNode = this.ownContext.createMediaStreamSource(inputStream);

    // Mono mic — both for the channel-count constraint upstream
    // (force_mono_mic_pipeline backport) and for ScriptProcessor CPU.
    this.dtlnNode = createDtlnProcessorNode(this.ownContext, {
      channelCount: 1,
    });

    this.destinationNode = this.ownContext.createMediaStreamDestination();

    this.sourceNode.connect(this.dtlnNode);
    this.dtlnNode.connect(this.destinationNode);

    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  /** No-op — DTLN suppression strength is not run-time tunable in this build. */
  setMicSensitivity(_sensitivity: number): void {
    // intentional no-op
  }

  /** No-op — DTLN has no suppression-level dial (model-fixed strength). */
  setNoiseSuppressionLevel(_level: unknown): void {
    // intentional no-op
  }

  /** No-op — DTLN has no pre-network gain node (see constructor comment). */
  setInputVolume(_volume: number): void {
    // intentional no-op
  }

  async destroy(): Promise<void> {
    try {
      this.sourceNode?.disconnect();
    } catch {
      /* already disconnected */
    }

    try {
      this.dtlnNode?.disconnect();
    } catch {
      /* already disconnected */
    }

    try {
      this.destinationNode?.disconnect();
    } catch {
      /* already disconnected */
    }

    try {
      await this.ownContext?.close();
    } catch {
      /* context already closed */
    }

    this.sourceNode = null;
    this.dtlnNode = null;
    this.destinationNode = null;
    this.ownContext = null;
    this.processedTrack = undefined;
  }
}

export { DtlnProcessor };
