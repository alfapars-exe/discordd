/**
 * Cosmetics validation + resolution (Faz G, Sözleşme §2/§3/§7).
 *
 * SECURITY BOUNDARY: nothing the server sends is ever used as raw CSS, HTML
 * or SVG. `parseCosmeticAsset` re-validates every asset against the same
 * schemas as Go `models.ValidateCosmeticAsset` (same test vectors): exact key
 * set, `v === 1`, `#rrggbb` colours (canonicalised to lower case), integer
 * angles 0–359, enum allowlists, raw size ≤ 512 bytes. Render code only ever
 * sees the typed, canonical result and applies colours as CSS custom
 * properties, angles as `${n}deg` and enums as allowlisted class names.
 */

import type { CSSProperties } from "react";
import type {
  CosmeticFormat,
  CosmeticSlots,
  CosmeticType,
  EquippedCosmetic,
  FrameAsset,
  FrameKey,
  NameFont,
  NameplateAsset,
  NameplatePattern,
  NameStyleAsset,
  ProfileEffectAsset,
  ProfileEffectKind,
  ProfileThemeAsset,
  RasterFrameAsset,
} from "../types/cosmetics";

// ─── Constants (§2) ───

export const COSMETIC_TYPES: readonly CosmeticType[] = [
  "avatar_frame",
  "nameplate",
  "name_style",
  "profile_theme",
  "profile_effect",
];
export const COSMETIC_FORMATS: readonly CosmeticFormat[] = ["svg", "css", "raster"];
export const FRAME_KEYS: readonly FrameKey[] = ["aurora", "ember", "frost", "sakura", "circuit", "laurel"];
export const NAMEPLATE_PATTERNS: readonly NameplatePattern[] = ["none", "dots", "stripes", "grain"];
export const NAME_FONTS: readonly NameFont[] = ["default", "bold", "mono"];
export const EFFECTS: readonly ProfileEffectKind[] = ["sparkle", "snow", "glow", "petals", "confetti", "stars"];

export const COSMETIC_ASSET_MAX_BYTES = 512;
export const COSMETIC_LOOKUP_MAX_IDS = 100;
export const COSMETIC_FRAME_SCALE = 1.25;

/** Exact upload shapes of server-made raster frames (G2). */
export const RASTER_FRAME_URL = /^\/api\/uploads\/cosmetics\/[a-f0-9]{16}\.png$/;
export const RASTER_FRAME_ANIMATED_URL = /^\/api\/uploads\/cosmetics\/[a-f0-9]{16}\.gif$/;

/** Shared, frozen "no cosmetics" value — a stable reference for selectors. */
export const EMPTY_SLOTS: CosmeticSlots = Object.freeze({}) as CosmeticSlots;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// ─── Primitive validators ───

type Rec = Record<string, unknown>;

function isRecord(x: unknown): x is Rec {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function hasExactKeys(rec: Rec, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(rec);
  for (const k of required) if (!(k in rec)) return false;
  for (const k of keys) if (!required.includes(k) && !optional.includes(k)) return false;
  return true;
}

function hex(x: unknown): string | null {
  return typeof x === "string" && HEX_RE.test(x) ? x.toLowerCase() : null;
}

function hexList(x: unknown, min: number, max: number): string[] | null {
  if (!Array.isArray(x) || x.length < min || x.length > max) return null;
  const out: string[] = [];
  for (const v of x) {
    const h = hex(v);
    if (!h) return null;
    out.push(h);
  }
  return out;
}

function angle(x: unknown): number | null {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 359 ? x : null;
}

function oneOf<T extends string>(x: unknown, allowed: readonly T[]): T | null {
  return typeof x === "string" && (allowed as readonly string[]).includes(x) ? (x as T) : null;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Accepts an already-decoded value or a raw JSON string; enforces the size cap. */
function decode(x: unknown): Rec | null {
  let value: unknown = x;
  if (typeof x === "string") {
    if (byteLength(x) > COSMETIC_ASSET_MAX_BYTES) return null;
    try {
      value = JSON.parse(x);
    } catch {
      return null;
    }
  } else {
    let raw: string | undefined;
    try {
      raw = JSON.stringify(x);
    } catch {
      return null;
    }
    if (raw === undefined || byteLength(raw) > COSMETIC_ASSET_MAX_BYTES) return null;
  }
  if (!isRecord(value)) return null;
  if (value.v !== 1) return null;
  return value;
}

// ─── Asset schemas (§3) ───

export type ParsedCosmetic =
  | { kind: "frame_svg"; asset: FrameAsset }
  | { kind: "frame_raster"; asset: RasterFrameAsset }
  | { kind: "nameplate"; asset: NameplateAsset }
  | { kind: "name_style"; asset: NameStyleAsset }
  | { kind: "profile_theme"; asset: ProfileThemeAsset }
  | { kind: "profile_effect"; asset: ProfileEffectAsset };

/**
 * Validates `x` against the schema of (type, format). Returns the typed,
 * canonical asset (key order as §3, lower-case hex) or null.
 */
export function parseCosmeticAsset(type: unknown, format: unknown, x: unknown): ParsedCosmetic | null {
  const t = oneOf(type, COSMETIC_TYPES);
  const f = oneOf(format, COSMETIC_FORMATS);
  if (!t || !f) return null;
  const rec = decode(x);
  if (!rec) return null;

  if (t === "avatar_frame" && f === "svg") {
    if (!hasExactKeys(rec, ["v", "frame"])) return null;
    const frame = oneOf(rec.frame, FRAME_KEYS);
    return frame ? { kind: "frame_svg", asset: { v: 1, frame } } : null;
  }

  if (t === "avatar_frame" && f === "raster") {
    if (!hasExactKeys(rec, ["v", "url"], ["animated_url"])) return null;
    if (typeof rec.url !== "string" || !RASTER_FRAME_URL.test(rec.url)) return null;
    if ("animated_url" in rec) {
      if (typeof rec.animated_url !== "string" || !RASTER_FRAME_ANIMATED_URL.test(rec.animated_url)) return null;
      return { kind: "frame_raster", asset: { v: 1, url: rec.url, animated_url: rec.animated_url } };
    }
    return { kind: "frame_raster", asset: { v: 1, url: rec.url } };
  }

  // Every non-frame type is a css token set.
  if (f !== "css") return null;

  switch (t) {
    case "nameplate": {
      if (!hasExactKeys(rec, ["v", "stops", "angle", "pattern"])) return null;
      const stops = hexList(rec.stops, 2, 3);
      const a = angle(rec.angle);
      const pattern = oneOf(rec.pattern, NAMEPLATE_PATTERNS);
      if (!stops || a === null || !pattern) return null;
      return { kind: "nameplate", asset: { v: 1, stops, angle: a, pattern } };
    }
    case "name_style": {
      if (!hasExactKeys(rec, ["v", "font", "stops", "angle"])) return null;
      const font = oneOf(rec.font, NAME_FONTS);
      const stops = hexList(rec.stops, 1, 2);
      const a = angle(rec.angle);
      if (!font || !stops || a === null) return null;
      return { kind: "name_style", asset: { v: 1, font, stops, angle: a } };
    }
    case "profile_theme": {
      if (!hasExactKeys(rec, ["v", "accent", "gradient", "angle"])) return null;
      const accent = hex(rec.accent);
      const gradient = hexList(rec.gradient, 2, 2);
      const a = angle(rec.angle);
      if (!accent || !gradient || a === null) return null;
      return { kind: "profile_theme", asset: { v: 1, accent, gradient: [gradient[0], gradient[1]], angle: a } };
    }
    case "profile_effect": {
      if (!hasExactKeys(rec, ["v", "effect", "color"])) return null;
      const effect = oneOf(rec.effect, EFFECTS);
      const color = hex(rec.color);
      if (!effect || !color) return null;
      return { kind: "profile_effect", asset: { v: 1, effect, color } };
    }
    default:
      return null;
  }
}

// ─── Typed slot accessors (render helpers) ───

export function frameOf(eq: EquippedCosmetic | undefined): ParsedCosmetic | null {
  if (!eq) return null;
  const p = parseCosmeticAsset("avatar_frame", eq.format, eq.asset);
  return p && (p.kind === "frame_svg" || p.kind === "frame_raster") ? p : null;
}

export function nameplateOf(eq: EquippedCosmetic | undefined): NameplateAsset | null {
  if (!eq) return null;
  const p = parseCosmeticAsset("nameplate", eq.format, eq.asset);
  return p && p.kind === "nameplate" ? p.asset : null;
}

export function nameStyleOf(eq: EquippedCosmetic | undefined): NameStyleAsset | null {
  if (!eq) return null;
  const p = parseCosmeticAsset("name_style", eq.format, eq.asset);
  return p && p.kind === "name_style" ? p.asset : null;
}

export function themeOf(eq: EquippedCosmetic | undefined): ProfileThemeAsset | null {
  if (!eq) return null;
  const p = parseCosmeticAsset("profile_theme", eq.format, eq.asset);
  return p && p.kind === "profile_theme" ? p.asset : null;
}

export function effectOf(eq: EquippedCosmetic | undefined): ProfileEffectAsset | null {
  if (!eq) return null;
  const p = parseCosmeticAsset("profile_effect", eq.format, eq.asset);
  return p && p.kind === "profile_effect" ? p.asset : null;
}

// ─── Slots ───

/** Parses one slot value; null when anything about it is invalid. */
export function parseEquipped(type: CosmeticType, x: unknown): EquippedCosmetic | null {
  if (!isRecord(x)) return null;
  if (typeof x.item_id !== "string" || x.item_id.length === 0 || x.item_id.length > 64) return null;
  const format = oneOf(x.format, COSMETIC_FORMATS);
  if (!format || typeof x.animated !== "boolean") return null;
  const parsed = parseCosmeticAsset(type, format, x.asset);
  if (!parsed) return null;
  return { item_id: x.item_id, format, animated: x.animated, asset: parsed.asset };
}

/** Parses a slots object; invalid or unknown slots are dropped silently. */
export function parseCosmeticSlots(x: unknown): CosmeticSlots {
  if (!isRecord(x)) return EMPTY_SLOTS;
  const out: CosmeticSlots = {};
  let any = false;
  for (const type of COSMETIC_TYPES) {
    if (!(type in x)) continue;
    const eq = parseEquipped(type, x[type]);
    if (eq) {
      out[type] = eq;
      any = true;
    }
  }
  return any ? out : EMPTY_SLOTS;
}

/** Structural equality of two parsed slot sets (used to keep references stable). */
export function slotsEqual(a: CosmeticSlots, b: CosmeticSlots): boolean {
  if (a === b) return true;
  for (const type of COSMETIC_TYPES) {
    const x = a[type];
    const y = b[type];
    if (!x && !y) continue;
    if (!x || !y) return false;
    if (x.item_id !== y.item_id || x.format !== y.format || x.animated !== y.animated) return false;
    if (JSON.stringify(x.asset) !== JSON.stringify(y.asset)) return false;
  }
  return true;
}

export function isEmptySlots(s: CosmeticSlots): boolean {
  return COSMETIC_TYPES.every((t) => !s[t]);
}

/**
 * Resolution rule (§7). Server context: plain → nothing; otherwise per type
 * the server override, else the global slot. Global context: global only.
 */
export function resolveSlots(
  global: CosmeticSlots,
  override: CosmeticSlots | undefined,
  opts: { inServer: boolean; plain: boolean },
): CosmeticSlots {
  if (!opts.inServer) return global;
  if (opts.plain) return EMPTY_SLOTS;
  if (!override || isEmptySlots(override)) return global;
  const out: CosmeticSlots = {};
  for (const type of COSMETIC_TYPES) {
    const v = override[type] ?? global[type];
    if (v) out[type] = v;
  }
  return out;
}

// ─── CSS custom properties (validated values only) ───

type CSSVars = CSSProperties & Record<`--${string}`, string>;

export function cssVarsForNameplate(a: NameplateAsset): CSSVars {
  const [s0, s1, s2] = a.stops;
  return {
    "--cos-np-a": s0,
    "--cos-np-b": s1 ?? s0,
    "--cos-np-c": s2 ?? s1 ?? s0,
    "--cos-np-angle": `${a.angle}deg`,
  };
}

export function cssVarsForNameStyle(a: NameStyleAsset): CSSVars {
  const [s0, s1] = a.stops;
  return {
    "--cos-ns-a": s0,
    "--cos-ns-b": s1 ?? s0,
    "--cos-ns-angle": `${a.angle}deg`,
  };
}

export function cssVarsForTheme(a: ProfileThemeAsset): CSSVars {
  return {
    "--cos-theme-a": a.gradient[0],
    "--cos-theme-b": a.gradient[1],
    "--cos-theme-angle": `${a.angle}deg`,
    "--mc-accent": a.accent,
  };
}

export function cssVarsForEffect(a: ProfileEffectAsset): CSSVars {
  return { "--cos-effect-color": a.color };
}
