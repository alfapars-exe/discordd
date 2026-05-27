/**
 * gateConfig — shared VAD-gate configuration helpers.
 *
 * Both RNNoiseProcessor (RNNoise + gate pipeline) and VadGateProcessor
 * (gate-only, no denoiser) feed the same `vad-gate-processor` worklet
 * with the same level + sensitivity → threshold curve. Centralising
 * the mapping + the postMessage shape here means a future tweak to the
 * curve only needs one edit.
 */

import type { NoiseSuppressionLevel } from "../stores/slices/voiceSettingsSlice";

/**
 * Per-level base thresholds in dB. Higher numbers (closer to 0) mean louder
 * sound is needed to open the gate — i.e. tighter noise rejection. closeThreshold
 * sits below openThreshold to give hysteresis (signal must dip below close
 * AND stay there `holdMs` before the gate fully closes), preventing flicker.
 *
 * Thresholds shifted ~10 dB more permissive across the board after reports
 * of quiet talkers / low-gain mics (laptop internal mic, cheap USB) being
 * fully silenced for remote listeners at the previous "medium" setting.
 * RMS for normal speech on weak hardware lands around -45..-50 dB; the old
 * medium=-42 never opened. New medium=-52 lets that through while still
 * rejecting keyboard/fan noise (typically -55..-65 dB).
 */
const LEVEL_BASE: Record<NoiseSuppressionLevel, { open: number; close: number; hold: number }> = {
  low:     { open: -60, close: -65, hold: 400 },
  medium:  { open: -52, close: -58, hold: 300 },
  high:    { open: -45, close: -52, hold: 200 },
  maximum: { open: -38, close: -45, hold: 150 },
};

/**
 * Combine level + sensitivity slider into final gate parameters.
 * sensitivity=100 disables the gate entirely (legacy "off" semantic).
 * Other sensitivity values offset the level's base by ±6 dB — slider toward
 * 0 makes the gate tighter, toward 100 makes it more permissive.
 */
export function levelToThresholds(
  level: NoiseSuppressionLevel,
  sensitivity: number,
): { openThresholdDb: number; closeThresholdDb: number; holdMs: number } | null {
  if (sensitivity >= 100) return null; // gate disabled
  const base = LEVEL_BASE[level];
  const offsetDb = ((50 - sensitivity) / 50) * 6; // -6 .. +6 dB
  return {
    openThresholdDb: base.open + offsetDb,
    closeThresholdDb: base.close + offsetDb,
    holdMs: base.hold,
  };
}

/**
 * Send the level+sensitivity mapping to the vad-gate worklet.
 * Null gate config (sensitivity=100) translates to a `{ disabled: true }`
 * payload that the worklet's port.onmessage recognises as pass-through.
 * No-op if the node hasn't been built yet (init() not called).
 */
export function postGateConfigToWorklet(
  node: AudioWorkletNode | null,
  level: NoiseSuppressionLevel,
  sensitivity: number,
): void {
  if (!node) return;
  const cfg = levelToThresholds(level, sensitivity);
  if (cfg == null) {
    node.port.postMessage({ disabled: true });
  } else {
    node.port.postMessage(cfg);
  }
}
