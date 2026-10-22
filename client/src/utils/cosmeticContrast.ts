/**
 * Name-style contrast (Faz G, Karar G-10, Sözleşme §4) — mirrors Go
 * `models.ContrastRatio` / `models.NameStyleReadable` with the same vectors.
 *
 * WCAG 2.x relative luminance. A 1-stop style is that colour; a 2-stop
 * gradient is sampled at t = k/8 (k = 0..8) with per-channel linear sRGB
 * interpolation rounded to the nearest integer. Every sample must reach
 * CONTRAST_MIN against the background. The server guarantees this against
 * the reference (lightest dark theme); the client re-checks against the
 * active theme and falls back to the default name colour when it fails.
 */

export const CONTRAST_MIN = 4.5;
export const CONTRAST_REFERENCE = "#3b4252";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

type RGB = [number, number, number];

function parseHex(hex: string): RGB | null {
  if (!HEX_RE.test(hex)) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function luminance([r, g, b]: RGB): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratioRGB(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG contrast ratio of two `#rrggbb` colours; 1 for invalid input. */
export function contrastRatio(a: string, b: string): number {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) return 1;
  return ratioRGB(ra, rb);
}

/** True when every sample of a 1–2 stop name style reaches CONTRAST_MIN on `bgHex`. */
export function nameStyleReadable(stops: readonly string[], bgHex: string = CONTRAST_REFERENCE): boolean {
  const bg = parseHex(bgHex);
  if (!bg || stops.length < 1 || stops.length > 2) return false;
  const parsed: RGB[] = [];
  for (const s of stops) {
    const rgb = parseHex(s);
    if (!rgb) return false;
    parsed.push(rgb);
  }
  if (parsed.length === 1) return ratioRGB(parsed[0], bg) >= CONTRAST_MIN;
  const [a, b] = parsed;
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    const sample: RGB = [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
    if (ratioRGB(sample, bg) < CONTRAST_MIN) return false;
  }
  return true;
}
