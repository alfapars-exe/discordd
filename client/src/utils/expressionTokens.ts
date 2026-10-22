/**
 * expressionTokens — custom emoji token grammar, reaction keys, slug rules
 * and composer shortcode conversion (Faz D1, Sözleşme §5–§6).
 *
 * Content token (client-generated, travels inside E2EE ciphertext as plain
 * text):   <:name:id>   /   <a:name:id>
 * Reaction key (server-validated, name-less so a rename never forks a
 * reaction group):   <:id>   /   <a:id>
 *
 * Only a regex-validated 16-hex id ever reaches a URL; `name` is used solely
 * as alt/title text.
 */

import type { ServerEmoji } from "../types/expression";
import { parseMarkdownLite, scanCodeSegments, type MdNode } from "./markdownLite";
import { parseStickerToken } from "./stickerTokens";

/** Global content-token matcher (use with matchAll / replace). */
export const CUSTOM_EMOJI_TOKEN = /<(a?):([a-z0-9_]{2,32}):([a-f0-9]{16})>/g;
/** Anchored single-token check. */
export const CUSTOM_EMOJI_TOKEN_EXACT = /^<(a?):([a-z0-9_]{2,32}):([a-f0-9]{16})>$/;
/** Anchored reaction-key check (server mirrors this as ParseReactionEmoji). */
export const REACTION_CUSTOM_KEY = /^<(a?):([a-f0-9]{16})>$/;
/** Valid expression slug. */
export const EXPRESSION_NAME = /^[a-z0-9_]{2,32}$/;
export const EMOJI_ID = /^[a-f0-9]{16}$/;

export const MAX_STATIC_EMOJIS = 100;
export const MAX_ANIMATED_EMOJIS = 50;
export const MAX_EMOJI_UPLOAD_BYTES = 512 * 1024;
export const MAX_DISPLAY_NAME_RUNES = 32;

export type CustomEmojiRef = { name: string; id: string; animated: boolean };

// ─── Slug / display name (Go: models.SlugifyExpressionName) ───────────

const TR_FOLD: Record<string, string> = {
  ç: "c", ğ: "g", ı: "i", İ: "i", ö: "o", ş: "s", ü: "u",
  Ç: "c", Ğ: "g", Ö: "o", Ş: "s", Ü: "u",
  â: "a", î: "i", û: "u",
};

/**
 * Derive the ASCII shortcode from a display name. Returns null when the
 * result is shorter than 2 characters. Must stay byte-identical with the Go
 * implementation — both sides share the Sözleşme §5 test vectors.
 */
export function slugifyExpressionName(input: string): string | null {
  let s = "";
  for (const ch of input) {
    const folded = TR_FOLD[ch] ?? ch;
    for (const c of folded) {
      const code = c.charCodeAt(0);
      if (c.length === 1 && code >= 65 && code <= 90) s += String.fromCharCode(code + 32);
      else if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "-" || c === ".") s += "_";
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || c === "_") s += c;
      // everything else is dropped
    }
  }
  s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (s.length > 32) s = s.slice(0, 32).replace(/_+$/, "");
  return s.length >= 2 ? s : null;
}

const STEERING = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** Client-side UX mirror of the server's display_name rule (server is authoritative). */
export function isValidDisplayName(raw: string): boolean {
  const s = raw.trim();
  const runes = [...s].length;
  if (runes < 1 || runes > MAX_DISPLAY_NAME_RUNES) return false;
  return !STEERING.test(s);
}

// ─── URLs / tokens / reaction keys ────────────────────────────────────

export function emojiStaticUrl(id: string): string {
  return `/api/uploads/emojis/${id}.png`;
}

export function emojiAnimatedUrl(id: string): string {
  return `/api/uploads/emojis/${id}.gif`;
}

export function buildEmojiToken(e: CustomEmojiRef): string {
  return `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`;
}

export function parseCustomEmojiToken(s: string): CustomEmojiRef | null {
  const m = CUSTOM_EMOJI_TOKEN_EXACT.exec(s);
  if (!m) return null;
  return { animated: m[1] === "a", name: m[2], id: m[3] };
}

/** Content token → reaction key; unicode (or anything else) passes through. */
export function toReactionKey(value: string): string {
  const t = parseCustomEmojiToken(value);
  if (!t) return value;
  return `<${t.animated ? "a" : ""}:${t.id}>`;
}

export type ParsedReactionKey =
  | { custom: true; id: string; animated: boolean }
  | { custom: false; emoji: string };

export function parseReactionKey(key: string): ParsedReactionKey {
  const m = REACTION_CUSTOM_KEY.exec(key);
  if (!m) return { custom: false, emoji: key };
  return { custom: true, animated: m[1] === "a", id: m[2] };
}

// ─── Composer conversion ──────────────────────────────────────────────

/**
 * Regions the composer must never rewrite: existing custom tokens, mentions
 * and URLs. One capture group (split contract shared with markdownLite).
 */
const PROTECTED_ATOMS = /(<a?:[a-z0-9_]{2,32}:[a-f0-9]{16}>|<@&?[a-z0-9]+>|https?:\/\/[^\s<|]+)/gi;
const SHORTCODE = /:([a-z0-9_]{2,32}):/g;

/**
 * Convert `:name:` shortcodes the user typed/selected into content tokens.
 *
 * Resolution order: explicit selections (picker/autocomplete) → the current
 * server's emojis → every other member server's emojis (ascending
 * server_id). Unknown names stay as typed. Code spans/blocks and URLs are
 * never touched; neither is a shortcode glued to a preceding letter/digit
 * (so `12:30:45` stays a time).
 *
 * @param byServer only servers the user is currently a member of.
 */
export function convertEmojiShortcodes(
  text: string,
  selections: CustomEmojiRef[],
  byServer: Record<string, ServerEmoji[]>,
  currentServerId: string | null | undefined,
): string {
  if (!text.includes(":")) return text;

  const byName = new Map<string, CustomEmojiRef>();
  for (const s of selections) if (!byName.has(s.name)) byName.set(s.name, s);
  const addServer = (list: ServerEmoji[] | undefined) => {
    if (!list) return;
    for (const e of list) {
      if (!byName.has(e.name)) byName.set(e.name, { name: e.name, id: e.id, animated: e.animated });
    }
  };
  if (currentServerId) addServer(byServer[currentServerId]);
  for (const sid of Object.keys(byServer).sort((a, b) => a.localeCompare(b))) {
    if (sid !== currentServerId) addServer(byServer[sid]);
  }
  if (byName.size === 0) return text;

  const replaceIn = (chunk: string): string =>
    chunk.replace(SHORTCODE, (match: string, name: string, offset: number, whole: string) => {
      const before = offset > 0 ? whole[offset - 1] : "";
      if (before && /[A-Za-z0-9_]/.test(before)) return match;
      const ref = byName.get(name);
      return ref ? buildEmojiToken(ref) : match;
    });

  let out = "";
  for (const seg of scanCodeSegments(text)) {
    if (seg.kind !== "text") {
      out += seg.raw;
      continue;
    }
    const parts = seg.raw.split(PROTECTED_ATOMS);
    for (let i = 0; i < parts.length; i++) {
      out += i % 2 === 1 ? parts[i] : replaceIn(parts[i]);
    }
  }
  return out;
}

// ─── Plain-text preview ───────────────────────────────────────────────

const PREVIEW_ATOMS = /(<a?:[a-z0-9_]{2,32}:[a-f0-9]{16}>|https?:\/\/[^\s<|]+)/g;
export const SPOILER_PLACEHOLDER = "▒▒▒";

function flattenPreview(nodes: MdNode[]): string {
  let out = "";
  // Explicit stack keeps this iterative like the parser.
  const stack: MdNode[][] = [nodes.slice().reverse()];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const n = top.pop();
    if (!n) {
      stack.pop();
      continue;
    }
    switch (n.type) {
      case "text":
      case "code":
      case "codeBlock":
        out += n.value;
        break;
      case "atom": {
        const t = parseCustomEmojiToken(n.value);
        out += t ? `:${t.name}:` : n.value;
        break;
      }
      case "spoiler":
        out += SPOILER_PLACEHOLDER;
        break;
      case "strong":
      case "em":
        stack.push(n.children.slice().reverse());
        break;
    }
  }
  return out;
}

/**
 * Single-line friendly preview: custom tokens → `:name:`, markdown markers
 * stripped, spoiler content masked. A whole-message sticker token becomes
 * `[name]` (Faz D2). Returns "" for null/empty input.
 */
export function plainPreview(text: string | null | undefined): string {
  if (!text) return "";
  const st = parseStickerToken(text);
  if (st) return `[${st.name}]`;
  return flattenPreview(parseMarkdownLite(text, PREVIEW_ATOMS));
}
