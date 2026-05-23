/**
 * Sensitivity → RMS-threshold conversion.
 *
 * Shared between RNNoiseProcessor and VadGateProcessor so the meaning of
 * the micSensitivity slider stays identical no matter which engine is
 * attached to the mic track. The two processors used to maintain their
 * own copies of this function which is exactly the kind of duplication
 * that drifts apart over time.
 *
 * Curve choice — cubic with a 0.025 ceiling:
 *
 *   100 -> 0       (gate disabled, everything passes)
 *    75 -> 0.0004  (very light gate — only the quietest room noise blocked)
 *    50 -> 0.003   (default — whispers pass, idle keyboard mostly stays out)
 *    25 -> 0.011   (aggressive — only clear voice passes)
 *     0 -> 0.025   (most aggressive)
 *
 * History: previously the curve was quadratic with a 0.04 ceiling, so
 * sensitivity=50 mapped to 0.01 RMS. That gate cut soft speech to silence
 * BEFORE it reached LiveKit's audio-level meter, which meant the "is
 * speaking" indicator (green ring) never fired for quiet talkers — the
 * audio they were producing was already being suppressed at the source.
 *
 * The cubic curve drops 3.3× lower at the default position so whispers
 * (~0.005 RMS) now make it through and trigger IsSpeakingChanged. Users
 * who want the OLD agressive baseline can lower the slider toward 25.
 *
 * Why cubic instead of just lowering the quadratic ceiling: the slider
 * also has to behave sensibly across its range. A purely linear or
 * shallow curve makes the bottom half of the slider feel "dead". Cubic
 * keeps responsive control near the noisy end (0-30) while flattening
 * the sensitive end (60-100) where users want fine adjustments.
 */

/** Convert micSensitivity (0–100) to an RMS energy gate threshold. */
export function sensitivityToThreshold(sensitivity: number): number {
  const clamped = Math.max(0, Math.min(100, sensitivity));
  const inverted = (100 - clamped) / 100;
  return 0.025 * inverted * inverted * inverted;
}
