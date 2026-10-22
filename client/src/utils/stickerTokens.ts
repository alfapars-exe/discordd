/**
 * stickerTokens — sticker message token grammar, URLs, limits and the
 * metadata rules shared with the server (Faz D2, Sözleşme §6–§7).
 *
 * A sticker message is a WHOLE-message content token (client-generated,
 * travels inside E2EE ciphertext as plain text):
 *     <sticker:name:id>   /   <sticker:a:name:id>
 * It is only recognised when `content.trim()` is exactly one token — there
 * is no inline sticker and no global matcher.
 *
 * Only a regex-validated 16-hex id ever reaches a URL; `name` is used solely
 * as alt/title/fallback text.
 *
 * Deliberately does NOT import expressionTokens.ts (that module imports this
 * one for plainPreview — keep the dependency one-way).
 */

import type { ServerSticker } from "../types/expression";

/** Anchored whole-message sticker token. */
export const STICKER_TOKEN_EXACT = /^<sticker:(?:(a):)?([a-z0-9_]{2,32}):([a-f0-9]{16})>$/;
export const STICKER_ID = /^[a-f0-9]{16}$/;

export const MAX_STICKERS = 30;
export const MAX_STICKER_UPLOAD_BYTES = 512 * 1024;
export const MAX_DESCRIPTION_RUNES = 100;
export const MAX_TAGS = 5;
export const MAX_TAG_RUNES = 20;

export type StickerRef = { name: string; id: string; animated: boolean };

export function buildStickerToken(s: StickerRef): string {
  return `<sticker:${s.animated ? "a:" : ""}${s.name}:${s.id}>`;
}

/** Parse a whole message as a sticker token (trimmed, anchored). */
export function parseStickerToken(text: string | null | undefined): StickerRef | null {
  if (!text) return null;
  const m = STICKER_TOKEN_EXACT.exec(text.trim());
  if (!m) return null;
  return { animated: m[1] === "a", name: m[2], id: m[3] };
}

export function stickerStaticUrl(id: string): string {
  return `/api/uploads/stickers/${id}.png`;
}

export function stickerAnimatedUrl(id: string): string {
  return `/api/uploads/stickers/${id}.gif`;
}

// ─── Metadata rules (Go: models.NormalizeStickerTags & co.) ────────────

/** Mirror of pkg.ContainsSteeringChars (Cc + Cf + line/para separators). */
const STEERING = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

function runeCount(s: string): number {
  return [...s].length;
}

/** Go strings.ToLower parity for the dedupe key (İ → i, not i̇). */
function goLower(s: string): string {
  let out = "";
  for (const ch of s) out += ch === "İ" ? "i" : ch.toLowerCase();
  return out;
}

/** UX mirror of the server's description rule (server is authoritative). */
export function isValidStickerDescription(raw: string): boolean {
  const s = raw.trim();
  return runeCount(s) <= MAX_DESCRIPTION_RUNES && !STEERING.test(s);
}

/**
 * Normalize tags exactly like the server: trim each, skip empties, reject
 * `,` / >20 runes / steering chars, dedupe case-insensitively keeping the
 * first spelling, reject more than 5. Returns null when invalid.
 */
export function normalizeStickerTags(tags: readonly string[]): string[] | null {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === "") continue;
    if (tag.includes(",") || runeCount(tag) > MAX_TAG_RUNES || STEERING.test(tag)) return null;
    const key = goLower(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.length > MAX_TAGS ? null : out;
}

/** Comma-separated text input → normalized tags (null when invalid). */
export function parseTagInput(input: string): string[] | null {
  return normalizeStickerTags(input.split(","));
}

/** Picker search: substring over display_name / name / tags, Turkish-aware case folding. */
export function matchStickerQuery(
  sticker: Pick<ServerSticker, "name" | "display_name" | "tags">,
  query: string,
): boolean {
  const q = query.trim().toLocaleLowerCase("tr-TR");
  if (!q) return true;
  if (sticker.display_name.toLocaleLowerCase("tr-TR").includes(q)) return true;
  if (sticker.name.toLocaleLowerCase("tr-TR").includes(q)) return true;
  return sticker.tags.some((tag) => tag.toLocaleLowerCase("tr-TR").includes(q));
}
