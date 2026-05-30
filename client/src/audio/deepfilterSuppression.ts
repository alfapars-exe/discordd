/**
 * deepfilterSuppression — maps the UI "suppression strength" slider (0–100 %)
 * to DeepFilterNet3's attenuation-limit in dB (the value handed to
 * df_set_atten_lim / df_create).
 *
 * Why a mapping instead of passing % straight through (the previous bug):
 * upstream libDF (`tract.rs` set_atten_lim, verified) interprets the argument
 * as dB and applies it as a linear gain floor:
 *
 *   db >= 100 → None      (no limit = FULL suppression)
 *   db < 0.01 → gain 1.0  (passthrough, ZERO reduction)
 *   else      → floor = 10^(-db/20);  out = enhanced·(1-floor) + noisy·floor
 *
 * So `(1 - floor)` is exactly the fraction of denoised signal mixed in. dB is
 * exponential, so feeding the slider value straight in as dB makes everything
 * above ~40 collapse to ≈full suppression — the upper ~60 % of the slider does
 * nothing. We invert into the mix domain so the control is perceptually linear:
 *
 *   floor = 1 - strength/100      // = "fraction of original kept"
 *   db    = -20·log10(floor)      // → df_set_atten_lim
 *
 * Result: 70 % strength ≈ "70 % denoised" (atten ≈ 10 dB), matching the
 * slider's implied meaning. Endpoints hit the exact upstream specials:
 *   0 %   → 0 dB   (passthrough)
 *   100 % → 100 dB (None = full DeepFilterNet3)
 *
 * Returns an integer dB in [0, 100] (the worklet floors to int dB anyway).
 */
export function strengthToAttenLimDb(strength: number): number {
  const s = Math.max(0, Math.min(100, strength));
  if (s <= 0) return 0; // passthrough — upstream gain floor 1.0
  if (s >= 100) return 100; // None — full suppression (avoids log10(0))
  const floor = 1 - s / 100; // fraction of the noisy/original signal kept
  return Math.min(100, Math.round(-20 * Math.log10(floor)));
}
