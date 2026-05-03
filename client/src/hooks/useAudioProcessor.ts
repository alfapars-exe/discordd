/**
 * useAudioProcessor — owns the LiveKit microphone track processor.
 *
 * Responsibility (single): keep the right audio processor attached to the
 * mic track based on the user's current noise-reduction settings. Three
 * engines are supported and switched in response to settings changes:
 *
 *   - "krisp"    — LiveKit Cloud's Krisp filter, lazy-imported. Requires
 *                  a paid Cloud plan; falls back to RNNoise on init
 *                  failure (toast + flips the user's setting).
 *   - "rnnoise"  — bundled OSS ML denoiser (default, free).
 *   - "vadgate"  — energy-gate only (no denoising), used when NR is off
 *                  but micSensitivity < 100.
 *   - "none"     — no processor (NR off, sensitivity at 100).
 *
 * Two effects manage the lifecycle: one applies the processor when the
 * mic track is first published (initial join), the other switches it
 * when settings change at runtime. Both share the same applyDesired()
 * helper so the Krisp lazy-import + RNNoise-fallback path lives in one
 * place — no duplicated logic.
 *
 * Was previously ~210 lines inline in VoiceStateManager.tsx with the
 * Krisp branch copy-pasted twice.
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
import { VadGateProcessor } from "../audio/VadGateProcessor";

type ProcessorType = "krisp" | "rnnoise" | "vadgate" | "none";

/**
 * Krisp returns LiveKit's TrackProcessor<Track.Kind.Audio> at runtime; we
 * don't pin its type here so the @livekit/krisp-noise-filter dependency
 * stays fully lazy (dynamic import — only fetched when the user opts in).
 */
type AudioProcessor = RNNoiseProcessor | VadGateProcessor | { name: string };

function getDesiredProcessor(
  nr: boolean,
  engine: "rnnoise" | "krisp",
  sens: number,
): ProcessorType {
  if (nr) return engine === "krisp" ? "krisp" : "rnnoise";
  if (sens < 100) return "vadgate";
  return "none";
}

function getCurrentProcessorType(processor: AudioProcessor | null): ProcessorType {
  if (!processor) return "none";
  if (processor instanceof RNNoiseProcessor) return "rnnoise";
  if (processor instanceof VadGateProcessor) return "vadgate";
  return "krisp";
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
  hooks: {
    isCancelled: () => boolean;
    onKrispFallback: () => void;
  },
): Promise<AudioProcessor | null> {
  if (desired === "krisp") {
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
      const fallback = new RNNoiseProcessor(sens, vol);
      await audioTrack.setProcessor(fallback);
      return fallback;
    }
  }

  if (desired === "rnnoise") {
    const proc = new RNNoiseProcessor(sens, vol);
    await audioTrack.setProcessor(proc);
    return proc;
  }

  if (desired === "vadgate") {
    const proc = new VadGateProcessor(sens, vol);
    await audioTrack.setProcessor(proc);
    return proc;
  }

  return null; // "none"
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
  useLayoutEffect(() => {
    noiseReductionRef.current = noiseReduction;
    noiseReductionEngineRef.current = noiseReductionEngine;
    micSensitivityRef.current = micSensitivity;
    inputVolumeRef.current = inputVolume;
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
      // Same processor type — just push the new sensitivity / volume into
      // the live processor instance (the JS-bound ones support it).
      const ref = processorRef.current;
      if (
        desired !== "none" &&
        desired !== "krisp" &&
        (ref instanceof RNNoiseProcessor || ref instanceof VadGateProcessor)
      ) {
        ref.setMicSensitivity(micSensitivity);
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

      const proc = await applyDesiredProcessor(audioTrack, desired, micSensitivity, inputVolume, {
        isCancelled: () => cancelled,
        onKrispFallback: () => {
          addToast("warning", "Krisp etkin değil, RNNoise'a geçildi.");
          setNoiseReductionEngine("rnnoise");
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
          {
            isCancelled: () => cancelled,
            onKrispFallback: () => {
              addToast("warning", "Krisp etkin değil, RNNoise'a geçildi.");
              setNoiseReductionEngine("rnnoise");
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
