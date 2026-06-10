/**
 * useMicTest — local mic-test pipeline for the Voice & Audio settings tab.
 *
 * Mirrors the real voice pipeline (input gain -> RNNoise -> VAD gate) so the
 * test meter tracks what remote listeners would actually hear. Owns the
 * MediaStream/AudioContext lifecycle; callers only flip the test on/off via
 * `toggleTesting`. Was previously inline in VoiceSettings.tsx.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useVoiceStore } from "../stores/voiceStore";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import vadGateWorkletPath from "../audio/vadGateWorklet.js?url";
import { postGateConfigToWorklet } from "../audio/gateConfig";

export function useMicTest(): {
  isTesting: boolean;
  toggleTesting: () => void;
  micLevel: number;
} {
  // Store inputs the pipeline depends on — subscribed here so the host
  // component only re-renders for the state its own JSX uses.
  const inputDevice = useVoiceStore((s) => s.inputDevice);
  const outputDevice = useVoiceStore((s) => s.outputDevice);
  const noiseReduction = useVoiceStore((s) => s.noiseReduction);
  const micSensitivity = useVoiceStore((s) => s.micSensitivity);
  const noiseSuppressionLevel = useVoiceStore((s) => s.noiseSuppressionLevel);
  const inputVolume = useVoiceStore((s) => s.inputVolume);

  const [isTesting, setIsTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const micTestRef = useRef<{
    stream: MediaStream;
    ctx: AudioContext;
    analyser: AnalyserNode;
    gainNode: GainNode;
    raf: number;
    rnnoiseNode: RnnoiseWorkletNode | null;
    vadGateNode: AudioWorkletNode | null;
    loopbackAudio: HTMLAudioElement | null;
  } | null>(null);

  const startMicTest = useCallback(async () => {
    try {
      // Match real voice pipeline constraints (browser AGC + AEC + NS)
      const audioConstraints: MediaTrackConstraints = {
        noiseSuppression: true,
        autoGainControl: true,
        echoCancellation: true,
        ...(inputDevice ? { deviceId: { exact: inputDevice } } : {}),
      };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);

      // Read current settings
      const nr = useVoiceStore.getState().noiseReduction;
      const sens = useVoiceStore.getState().micSensitivity;
      const inVol = useVoiceStore.getState().inputVolume;
      const level = useVoiceStore.getState().noiseSuppressionLevel;

      // Input volume GainNode — applied before all processing (same as real pipeline)
      const gainNode = ctx.createGain();
      gainNode.gain.value = inVol / 100;
      source.connect(gainNode);

      let lastNode: AudioNode = gainNode;
      let rnnoiseNode: RnnoiseWorkletNode | null = null;
      let vadGateNode: AudioWorkletNode | null = null;

      if (nr) {
        // Full pipeline: source -> RNNoise -> VAD gate. Mirrors RNNoiseProcessor.init.
        const wasmBinary = await loadRnnoise({
          url: rnnoiseWasmPath,
          simdUrl: rnnoiseSimdWasmPath,
        });

        await Promise.all([
          ctx.audioWorklet.addModule(rnnoiseWorkletPath),
          ctx.audioWorklet.addModule(vadGateWorkletPath),
        ]);

        rnnoiseNode = new RnnoiseWorkletNode(ctx, {
          wasmBinary,
          maxChannels: 1,
        });

        vadGateNode = new AudioWorkletNode(ctx, "vad-gate-processor");
        // Use the SAME hysteresis dB curve as the live mic pipeline (see
        // RNNoiseProcessor.applyGateConfig). The previous one-shot
        // `{threshold}` payload triggered the worklet's legacy single-
        // threshold mode with a much tighter curve than the real pipeline,
        // so the test bar said "gate closed" while the real publisher was
        // still passing audio (and vice-versa).
        postGateConfigToWorklet(vadGateNode, level, sens);

        gainNode.connect(rnnoiseNode);
        rnnoiseNode.connect(vadGateNode);
        lastNode = vadGateNode;
      } else if (sens < 100) {
        // VAD gate only (no noise reduction but sensitivity threshold active)
        await ctx.audioWorklet.addModule(vadGateWorkletPath);
        vadGateNode = new AudioWorkletNode(ctx, "vad-gate-processor");
        postGateConfigToWorklet(vadGateNode, level, sens);
        gainNode.connect(vadGateNode);
        lastNode = vadGateNode;
      }

      // Analyser after processing — shows post-pipeline levels
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      lastNode.connect(analyser);

      // Loopback: route processed audio to selected output device
      const loopbackDest = ctx.createMediaStreamDestination();
      lastNode.connect(loopbackDest);
      const loopbackAudio = new Audio();
      loopbackAudio.srcObject = loopbackDest.stream;
      if (outputDevice && typeof loopbackAudio.setSinkId === "function") {
        await loopbackAudio.setSinkId(outputDevice).catch(() => {});
      }
      loopbackAudio.play().catch(() => {});

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      function tick() {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        setMicLevel(Math.min(100, Math.round((avg / 128) * 100)));
        if (micTestRef.current) {
          micTestRef.current.raf = requestAnimationFrame(tick);
        }
      }

      micTestRef.current = { stream, ctx, analyser, gainNode, raf: 0, rnnoiseNode, vadGateNode, loopbackAudio };
      micTestRef.current.raf = requestAnimationFrame(tick);
      // NOTE: setIsTesting is intentionally NOT called here — the
      // caller (button click handler OR the lifecycle effect below)
      // flips isTesting, and this function only owns the pipeline.
      // Keeping setState out of here is what lets the
      // restart-on-deps-change effect call us without tripping
      // react-hooks/set-state-in-effect.
    } catch (err) {
      console.error("[MicTest] Failed to start:", err);
    }
  }, [inputDevice, outputDevice]);

  const stopMicTest = useCallback(() => {
    if (!micTestRef.current) return;
    const { stream, ctx, raf, rnnoiseNode, vadGateNode, loopbackAudio } = micTestRef.current;
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    if (loopbackAudio) {
      loopbackAudio.pause();
      loopbackAudio.srcObject = null;
    }
    try { rnnoiseNode?.disconnect(); rnnoiseNode?.destroy(); } catch { /* node already destroyed or never initialized */ }
    try { vadGateNode?.disconnect(); } catch { /* node already destroyed or never initialized */ }
    ctx.close().catch(() => {});
    micTestRef.current = null;
    setMicLevel(0);
    // setIsTesting NOT called here — same reason as in startMicTest:
    // ownership of the boolean lives with the button handler / the
    // lifecycle effect so the pipeline functions stay
    // setState-free and can be safely invoked from effects.
  }, []);

  // Stop mic test on unmount
  useEffect(() => {
    return () => {
      if (micTestRef.current) {
        const { stream, ctx, raf, rnnoiseNode, loopbackAudio } = micTestRef.current;
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((t) => t.stop());
        if (loopbackAudio) {
          loopbackAudio.pause();
          loopbackAudio.srcObject = null;
        }
        try { rnnoiseNode?.disconnect(); rnnoiseNode?.destroy(); } catch { /* node already destroyed or never initialized */ }
        ctx.close().catch(() => {});
        micTestRef.current = null;
      }
    };
  }, []);

  // Single source of truth for the mic-test pipeline lifecycle:
  // whenever `isTesting` flips on (or its inputs change while on),
  // tear down the previous pipeline and build a fresh one with the
  // current settings; whenever `isTesting` flips off, just tear down.
  // The button below only toggles isTesting via setState — this
  // effect does the actual stream/AudioContext work. Crucially the
  // pipeline functions (startMicTest / stopMicTest) no longer call
  // setIsTesting themselves, so they're safe to invoke from inside an
  // effect without tripping react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!isTesting) return;
    void startMicTest();
    return () => {
      stopMicTest();
    };
  }, [isTesting, inputDevice, outputDevice, noiseReduction, startMicTest, stopMicTest]);

  // Update VAD gate config live when sensitivity or level changes during test.
  // Uses the same gateConfig helper as the real pipeline so the test bar
  // tracks what remote listeners would actually hear.
  useEffect(() => {
    if (micTestRef.current?.vadGateNode) {
      postGateConfigToWorklet(
        micTestRef.current.vadGateNode,
        noiseSuppressionLevel,
        micSensitivity,
      );
    }
  }, [micSensitivity, noiseSuppressionLevel]);

  // Update gain live when input volume changes during test
  useEffect(() => {
    if (micTestRef.current?.gainNode) {
      micTestRef.current.gainNode.gain.value = inputVolume / 100;
    }
  }, [inputVolume]);

  // The mic-test button only flips this boolean — the lifecycle effect above
  // owns the actual stream/AudioContext work.
  const toggleTesting = useCallback(() => {
    setIsTesting((prev) => !prev);
  }, []);

  return { isTesting, toggleTesting, micLevel };
}
