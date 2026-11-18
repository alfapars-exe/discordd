/** Store-free contracts for per-peer voice preference maps. */
export const VOICE_PEER_VOLUME_RANGE = [0, 200] as const;
export const VOICE_PEER_VOLUME_PRESETS = [VOICE_PEER_VOLUME_RANGE[0], 25, 50, 75, 100, 150, VOICE_PEER_VOLUME_RANGE[1]] as const;
export const VOICE_PEER_MAP_KEYS = ["userVolumes", "screenShareVolumes", "localMutedUsers"] as const;
export type VoicePeerMap = (typeof VOICE_PEER_MAP_KEYS)[number];
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isVoicePeerKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !RESERVED_KEYS.has(value);
}
export function isVoicePeerMap(field: string): field is VoicePeerMap {
  return VOICE_PEER_MAP_KEYS.some(key => key === field);
}
export function clampVoicePeerVolume(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(VOICE_PEER_VOLUME_RANGE[0], Math.min(VOICE_PEER_VOLUME_RANGE[1], value));
}
function validMapValue(field: VoicePeerMap, value: unknown): value is number | boolean {
  if (field === "localMutedUsers") return typeof value === "boolean";
  return typeof value === "number" && Number.isFinite(value) && value >= VOICE_PEER_VOLUME_RANGE[0] && value <= VOICE_PEER_VOLUME_RANGE[1];
}
/** Recovery rejects invalid values; live finite edits clamp before persistence. */
export function sanitizeVoicePeerMap(field: VoicePeerMap, value: unknown): Record<string, number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries: [string, number | boolean][] = [];
  for (const [id, item] of Object.entries(value)) {
    if (isVoicePeerKey(id) && validMapValue(field, item)) entries.push([id, item]);
  }
  return Object.fromEntries(entries);
}

/** Dictionary fallback must not treat Object.prototype members as preferences. */
export function ownVoicePeerValue<T>(record: Readonly<Record<string, T>>, id: string): T | undefined {
  return Object.hasOwn(record, id) ? record[id] : undefined;
}
export function voicePeerVolume(record: Readonly<Record<string, number>>, id: string): number {
  return ownVoicePeerValue(record, id) ?? 100;
}
