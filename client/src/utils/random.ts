/**
 * random — CSPRNG-backed drop-in replacements for Math.random().
 *
 * Even purely cosmetic uses (animation jitter, retry backoff) trip static
 * analysis "insufficiently random values" findings, so every Math.random()
 * call site in the client is routed through this single helper instead —
 * removing the pattern from the codebase closes the finding for good.
 */

/** Random float in [0, 1) — API-compatible drop-in for Math.random(). */
export function randomUnit(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

/** Random float in [min, max). */
export function randomRange(min: number, max: number): number {
  return min + randomUnit() * (max - min);
}
