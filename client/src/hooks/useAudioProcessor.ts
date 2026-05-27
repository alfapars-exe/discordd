/**
 * useAudioProcessor — owns the LiveKit microphone track processor.
 *
 * Responsibility (single): keep the right audio processor attached to the
 * mic track based on the user's current noise-reduction settings. Two
 * pipelines are supported:
 *
 *   Custom-processor pipeline (LiveKit TrackProcessor + AudioWorklet):
 *     - "krisp"      — LiveKit Cloud's Krisp filter, lazy-imported.
 *                      Requires a paid plan; falls back to RNNoise.
 *     - "rnnoise"    — bundled OSS ML denoiser (default, free).
 *     - "deepfilter" — DeepFilterNet3 (Rikorose) running native at 48 kHz
 *                      via the deepfilternet3-noise-filter package.
 *                      Real WASM + ONNX inference; suppression level is
 *                      live-tunable through setSuppressionLevel(0-100).
 *     - "dtln"       — DTLN (Dual-signal Transformation LSTM Network,
 *                      Westhausen 2020) via @sapphi-red/dtln-web. Runs at
 *                      16 kHz in a dedicated AudioContext; see DtlnProcessor.
 *     - "speex"      — Speex DSP noise suppression WASM.
 *     - "vadgate"    — energy-gate only, used when NR is off but
 *                      micSensitivity < 100.
 *
 *   Browser-native pipeline (track constraint):
 *     - "webrtc"     — getUserMedia({ noiseSuppression: true }) on the
 *                      mic MediaStreamTrack. No processor, no WASM. We
 *                      stop any custom processor and flip the constraint.
 *
 *   - "none"         — no processor, no NS constraint (NR off, sens 100).
 *
 * Browser-native NS is also explicitly *disabled* whenever a custom
 * processor is attached — running both layers can phase-cancel speech
 * components and over-suppress quiet talkers.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import {
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type Room,
  type LocalParticipant,
} from "livekit-client";

import { useVoiceStore } from "../stores/voiceStore";
import { useToastStore } from "../stores/toastStore";
import { RNNoiseProcessor } from "../audio/RNNoiseProcessor";
import { SpeexProcessor } from "../audio/SpeexProcessor";
import { VadGateProcessor } from "../audio/VadGateProcessor";
import { DtlnProcessor } from "../audio/DtlnProcessor";
import {
  DeepFilterNoiseFilter,
  DeepFilterNoiseFilterProcessor,
} from "deepfilternet3-noise-filter";
import type { NoiseSuppressionLevel, NoiseReductionEngine } from "../stores/slices/voiceSettingsSlice";

type ProcessorType =
  | "krisp"
  | "rnnoise"
  | "deepfilter"
  | "dtln"
  | "speex"
  | "webrtc"
  | "vadgate"
  | "none";

/**
 * Sentinel object used as the processor ref when WebRTC native NS is
 * active. WebRTC NS isn't a LiveKit TrackProcessor — it's a constraint
 * on the underlying MediaStreamTrack — but we still need *something* in
 * processorRef so the "current processor type" check can detect it and
 * switch correctly when the user picks a different engine.
 */
const WEBRTC_SENTINEL = { name: "webrtc-native" } as const;

/**
 * AudioProcessor type union supporting all active WASM, native, and DSP engines.
 */
type AudioProcessor =
  | RNNoiseProcessor
  | SpeexProcessor
  | VadGateProcessor
  | DtlnProcessor
  | DeepFilterNoiseFilterProcessor
  | { name: string };

function getDesiredProcessor(
  nr: boolean,
  engine: NoiseReductionEngine,
  sens: number,
): ProcessorType {
  if (nr) {
    if (engine === "krisp") return "krisp";
    if (engine === "webrtc") return "webrtc";
    if (engine === "speex") return "speex";
    if (engine === "deepfilter") return "deepfilter";
    if (engine === "dtln") return "dtln";
    return "rnnoise";
  }
  if (sens < 100) return "vadgate";
  return "none";
}

function getCurrentProcessorType(processor: AudioProcessor | null): ProcessorType {
  if (!processor) return "none";
  if (processor instanceof RNNoiseProcessor) return "rnnoise";
  if (processor instanceof SpeexProcessor) return "speex";
  if (processor instanceof VadGateProcessor) return "vadgate";
  if (processor instanceof DtlnProcessor) return "dtln";
  if (processor instanceof DeepFilterNoiseFilterProcessor) return "deepfilter";
  if (processor === WEBRTC_SENTINEL) return "webrtc";
  return "krisp";
}

/**
 * Toggle the browser-native noiseSuppression constraint on the underlying
 * MediaStreamTrack. Used by the "webrtc" branch (turns it on) and by
 * every custom-processor branch (turns it off, so we never run two NS
 * layers at once). Errors are non-fatal — some Linux/Wayland builds
 * reject applyConstraints; we log and move on rather than abort.
 */
async function setBrowserNoiseSuppression(
  audioTrack: LocalAudioTrack,
  enabled: boolean,
): Promise<void> {
  const mst = audioTrack.mediaStreamTrack;
  if (!mst) return;
  try {
    await mst.applyConstraints({ noiseSuppression: enabled });
  } catch (err) {
    console.warn("[useAudioProcessor] applyConstraints(noiseSuppression) failed:", err);
  }
}

/**
 * Single source of truth for "create the processor of type X and attach it
 * to the track". Used by both the runtime switch effect and the on-publish
 * effect so the Krisp fallback path isn't duplicated.
 *
 * Returns the attached processor, or null if cancelled mid-flight (caller
 * should bail without writing to its ref).
 */
async function applyDesiredProcessor(
  audioTrack: LocalAudioTrack,
  desired: ProcessorType,
  sens: number,
  vol: number,
  level: NoiseSuppressionLevel,
  deepfilterSuppression: number,
  hooks: {
    isCancelled: () => boolean;
    onKrispFallback: () => void;
    onDeepFilterFallback: () => void;
    onDtlnFallback: () => void;
    onRnnoiseFallback: () => void;
  },
): Promise<AudioProcessor | null> {
  if (desired === "krisp") {
    // Krisp + custom processor → make sure browser NS is off.
    await setBrowserNoiseSuppression(audioTrack, false);
    try {
      const { KrispNoiseFilter, isKrispNoiseFilterSupported } =
        await import("@livekit/krisp-noise-filter");
      if (hooks.isCancelled()) return null;
      if (!isKrispNoiseFilterSupported()) {
        throw new Error("Krisp not supported in this browser");
      }
      const proc = KrispNoiseFilter();
      if (hooks.isCancelled()) return null;
      await audioTrack.setProcessor(proc);
      return proc as unknown as AudioProcessor;
    } catch (err) {
      console.warn("[useAudioProcessor] Krisp init failed, falling back to RNNoise:", err);
      hooks.onKrispFallback();
      if (hooks.isCancelled()) return null;
      const fallback = new RNNoiseProcessor(sens, vol, level);
      await audioTrack.setProcessor(fallback);
      return fallback;
    }
  }

  if (desired === "rnnoise") {
    await setBrowserNoiseSuppression(audioTrack, false);
    try {
      const proc = new RNNoiseProcessor(sens, vol, level);
      await audioTrack.setProcessor(proc);
      return proc;
    } catch (err) {
      console.warn("[useAudioProcessor] RNNoise init failed, falling back to browser NS:", err);
      hooks.onRnnoiseFallback();
      if (hooks.isCancelled()) return null;
      await setBrowserNoiseSuppression(audioTrack, true);
      return WEBRTC_SENTINEL;
    }
  }

  if (desired === "speex") {
    await setBrowserNoiseSuppression(audioTrack, false);
    try {
      const proc = new SpeexProcessor(sens, vol, level);
      await audioTrack.setProcessor(proc);
      return proc;
    } catch (err) {
      console.warn("[useAudioProcessor] Speex init failed, falling back to browser NS:", err);
      hooks.onRnnoiseFallback();
      if (hooks.isCancelled()) return null;
      await setBrowserNoiseSuppression(audioTrack, true);
      return WEBRTC_SENTINEL;
    }
  }

  if (desired === "deepfilter") {
    await setBrowserNoiseSuppression(audioTrack, false);
    try {
      const proc = DeepFilterNoiseFilter({
        sampleRate: 48000,
        noiseReductionLevel: deepfilterSuppression,
        enabled: true,
      });
      await audioTrack.setProcessor(proc);
      return proc;
    } catch (err) {
      console.warn("[useAudioProcessor] DeepFilterNet3 init failed, falling back to RNNoise:", err);
      hooks.onDeepFilterFallback();
      if (hooks.isCancelled()) return null;
      const fallback = new RNNoiseProcessor(sens, vol, level);
      await audioTrack.setProcessor(fallback);
      return fallback;
    }
  }

  if (desired === "dtln") {
    await setBrowserNoiseSuppression(audioTrack, false);
    try {
      const proc = new DtlnProcessor(sens, vol);
      await audioTrack.setProcessor(proc);
      return proc;
    } catch (err) {
      console.warn("[useAudioProcessor] DTLN init failed, falling back to RNNoise:", err);
      hooks.onDtlnFallback();
      if (hooks.isCancelled()) return null;
      const fallback = new RNNoiseProcessor(sens, vol, level);
      await audioTrack.setProcessor(fallback);
      return fallback;
    }
  }

  if (desired === "webrtc") {
    // Browser-native NS: drop any custom processor and flip the track
    // constraint. Returns a sentinel so getCurrentProcessorType can
    // recognise this state and avoid re-applying the constraint on
    // subsequent settings updates that don't actually change the engine.
    await audioTrack.stopProcessor();
    await setBrowserNoiseSuppression(audioTrack, true);
    return WEBRTC_SENTINEL;
  }

  if (desired === "vadgate") {
    await setBrowserNoiseSuppression(audioTrack, false);
    const proc = new VadGateProcessor(sens, vol, level);
    await audioTrack.setProcessor(proc);
    return proc;
  }

  // "none" — also clear the browser constraint so the user gets raw mic
  // audio when both NR and the gate are off.
  await setBrowserNoiseSuppression(audioTrack, false);
  return null;
}

export function useAudioProcessor(
  room: Room,
  localParticipant: LocalParticipant,
  initialSyncDoneRef: React.RefObject<boolean>,
): void {
  const noiseReduction = useVoiceStore((s) => s.noiseReduction);
  const noiseReductionEngine = useVoiceStore((s) => s.noiseReductionEngine);
  const setNoiseReductionEngine = useVoiceStore((s) => s.setNoiseReductionEngine);
  const micSensitivity = useVoiceStore((s) => s.micSensitivity);
  const inputVolume = useVoiceStore((s) => s.inputVolume);
  const noiseSuppressionLevel = useVoiceStore((s) => s.noiseSuppressionLevel);
  const deepfilterSuppression = useVoiceStore((s) => s.deepfilterSuppression);
  const addToast = useToastStore((s) => s.addToast);

  // The currently attached processor, or null if "none".
  const processorRef = useRef<AudioProcessor | null>(null);

  // Latest-refs: read inside the on-publish event handler that doesn't
  // re-register on every settings change. Updated in useLayoutEffect (sync,
  // before browser paint) — React 19's react-hooks/refs rule disallows
  // writing .current during render.
  const noiseReductionRef = useRef(noiseReduction);
  const noiseReductionEngineRef = useRef(noiseReductionEngine);
  const micSensitivityRef = useRef(micSensitivity);
  const inputVolumeRef = useRef(inputVolume);
  const noiseSuppressionLevelRef = useRef(noiseSuppressionLevel);
  const deepfilterSuppressionRef = useRef(deepfilterSuppression);
  useLayoutEffect(() => {
    noiseReductionRef.current = noiseReduction;
    noiseReductionEngineRef.current = noiseReductionEngine;
    micSensitivityRef.current = micSensitivity;
    inputVolumeRef.current = inputVolume;
    noiseSuppressionLevelRef.current = noiseSuppressionLevel;
    deepfilterSuppressionRef.current = deepfilterSuppression;
  });

  // Effect A: switch processor when settings change at runtime.
  useEffect(() => {
    if (!initialSyncDoneRef.current) return;

    const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
    const audioTrack = pub?.track as LocalAudioTrack | undefined;
    if (!audioTrack) return;

    const desired = getDesiredProcessor(noiseReduction, noiseReductionEngine, micSensitivity);
    const current = getCurrentProcessorType(processorRef.current);

    if (desired === current) {
      // Same processor type — push live setting updates into the existing
      // processor instance instead of rebuilding the graph. Routing per
      // engine:
      //   - DeepFilter: setSuppressionLevel (0-100) is live-tunable.
      //   - DTLN: model strength is fixed, only volume cached.
      //   - VadGateProcessor: full sens/vol/level retune (gate-only mode).
      //   - RNNoise/Speex: only inputVolume — gate removed in v2.11.80.
      const ref = processorRef.current;
      if (ref instanceof DeepFilterNoiseFilterProcessor) {
        ref.setSuppressionLevel(deepfilterSuppression);
      } else if (ref instanceof DtlnProcessor) {
        ref.setInputVolume(inputVolume);
      } else if (ref instanceof VadGateProcessor) {
        ref.setMicSensitivity(micSensitivity);
        ref.setInputVolume(inputVolume);
        ref.setNoiseSuppressionLevel(noiseSuppressionLevel);
      } else if (ref instanceof RNNoiseProcessor || ref instanceof SpeexProcessor) {
        ref.setInputVolume(inputVolume);
      }
      return;
    }

    let cancelled = false;

    (async () => {
      if (processorRef.current) {
        await audioTrack.stopProcessor();
        processorRef.current = null;
      }
      if (cancelled) return;

      const proc = await applyDesiredProcessor(audioTrack, desired, micSensitivity, inputVolume, noiseSuppressionLevel, deepfilterSuppression, {
        isCancelled: () => cancelled,
        onKrispFallback: () => {
          addToast("warning", "Krisp etkin değil, RNNoise'a geçildi.");
          setNoiseReductionEngine("rnnoise");
        },
        onDeepFilterFallback: () => {
          addToast("warning", "DeepFilterNet3 yüklenemedi, RNNoise'a geçildi.");
          setNoiseReductionEngine("rnnoise");
        },
        onDtlnFallback: () => {
          addToast("warning", "DTLN yüklenemedi, RNNoise'a geçildi.");
          setNoiseReductionEngine("rnnoise");
        },
        onRnnoiseFallback: () => {
          addToast("warning", "RNNoise yüklenemedi, tarayıcı gürültü azaltmasına geçildi.");
          setNoiseReductionEngine("webrtc");
        },
      });
      if (cancelled) return;
      processorRef.current = proc;
    })().catch((err) => {
      if (!cancelled) {
        console.error("[useAudioProcessor] failed to switch processor:", err);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    noiseReduction,
    noiseReductionEngine,
    micSensitivity,
    inputVolume,
    noiseSuppressionLevel,
    deepfilterSuppression,
    localParticipant,
    addToast,
    setNoiseReductionEngine,
    initialSyncDoneRef,
  ]);

  // Effect B: apply processor when the mic track is first published.
  // The settings effect won't fire on initial publish because no setting
  // changed.
  useEffect(() => {
    let cancelled = false;

    function handleLocalTrackPublished(pub: LocalTrackPublication) {
      if (pub.source !== Track.Source.Microphone) return;
      if (processorRef.current) return; // already applied

      const desired = getDesiredProcessor(
        noiseReductionRef.current,
        noiseReductionEngineRef.current,
        micSensitivityRef.current,
      );
      if (desired === "none") return;

      const audioTrack = pub.track as LocalAudioTrack | undefined;
      if (!audioTrack) return;

      (async () => {
        const proc = await applyDesiredProcessor(
          audioTrack,
          desired,
          micSensitivityRef.current,
          inputVolumeRef.current,
          noiseSuppressionLevelRef.current,
          deepfilterSuppressionRef.current,
          {
            isCancelled: () => cancelled,
            onKrispFallback: () => {
              addToast("warning", "Krisp etkin değil, RNNoise'a geçildi.");
              setNoiseReductionEngine("rnnoise");
            },
            onDeepFilterFallback: () => {
              addToast("warning", "DeepFilterNet3 yüklenemedi, RNNoise'a geçildi.");
              setNoiseReductionEngine("rnnoise");
            },
            onDtlnFallback: () => {
              addToast("warning", "DTLN yüklenemedi, RNNoise'a geçildi.");
              setNoiseReductionEngine("rnnoise");
            },
            onRnnoiseFallback: () => {
              addToast("warning", "RNNoise yüklenemedi, tarayıcı gürültü azaltmasına geçildi.");
              setNoiseReductionEngine("webrtc");
            },
          },
        );
        if (cancelled) return;
        processorRef.current = proc;
      })().catch((err) => {
        if (!cancelled) {
          console.error("[useAudioProcessor] failed to apply on publish:", err);
        }
      });
    }

    room.on(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
    return () => {
      cancelled = true;
      room.off(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
    };
  }, [room, addToast, setNoiseReductionEngine]);
}
