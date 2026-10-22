import { describe, it, expect } from "vitest";
import {
  buildEmojiToken,
  convertEmojiShortcodes,
  emojiAnimatedUrl,
  emojiStaticUrl,
  isValidDisplayName,
  parseCustomEmojiToken,
  parseReactionKey,
  plainPreview,
  slugifyExpressionName,
  toReactionKey,
} from "./expressionTokens";
import type { ServerEmoji } from "../types/expression";

const ID_A = "0123456789abcdef";
const ID_B = "fedcba9876543210";
const ID_C = "aaaaaaaaaaaaaaaa";

function emoji(id: string, serverId: string, name: string, animated = false): ServerEmoji {
  return {
    id,
    server_id: serverId,
    name,
    display_name: name,
    animated,
    url: emojiStaticUrl(id),
    animated_url: animated ? emojiAnimatedUrl(id) : null,
    copyable: false,
    cloned_from: null,
    created_by: null,
    created_at: "2026-10-22T10:00:00Z",
  };
}

describe("slugifyExpressionName — shared Go/TS vectors (Sözleşme §5)", () => {
  const vectors: [string, string | null][] = [
    ["Şaşkın Kedi", "saskin_kedi"],
    ["İyi Günler!", "iyi_gunler"],
    ["ÇOK-ÖZEL", "cok_ozel"],
    ["  a  ", null],
    ["__x__", null],
    ["🐱cat", "cat"],
    ["ab", "ab"],
    ["a.b-c d", "a_b_c_d"],
    ["abcdefghijklmnopqrstuvwxyz_0123456789", "abcdefghijklmnopqrstuvwxyz_01234"],
    ["x___y", "x_y"],
  ];
  for (const [input, want] of vectors) {
    it(`${JSON.stringify(input)} → ${want ?? "invalid"}`, () => {
      expect(slugifyExpressionName(input)).toBe(want);
    });
  }
  it("trims a trailing _ left by the 32-char cut", () => {
    expect(slugifyExpressionName(`${"a".repeat(31)} b`)).toBe("a".repeat(31));
  });
});

describe("isValidDisplayName", () => {
  it("accepts Turkish letters", () => expect(isValidDisplayName("Şaşkın Kedi")).toBe(true));
  it("rejects empty / whitespace", () => expect(isValidDisplayName("   ")).toBe(false));
  it("rejects > 32 runes", () => expect(isValidDisplayName("ğ".repeat(33))).toBe(false));
  it("counts runes, not UTF-16 units", () => expect(isValidDisplayName("🐱".repeat(32))).toBe(true));
  it("rejects bidi override", () => expect(isValidDisplayName("a\u202Eb")).toBe(false));
  it("rejects control chars", () => expect(isValidDisplayName("a\u0007b")).toBe(false));
});

describe("tokens and reaction keys", () => {
  it("parses static and animated tokens", () => {
    expect(parseCustomEmojiToken(`<:kedi:${ID_A}>`)).toEqual({ animated: false, name: "kedi", id: ID_A });
    expect(parseCustomEmojiToken(`<a:kedi:${ID_A}>`)).toEqual({ animated: true, name: "kedi", id: ID_A });
  });
  it("rejects malformed tokens (uppercase id, short id, bad name)", () => {
    expect(parseCustomEmojiToken(`<:kedi:${ID_A.toUpperCase()}>`)).toBeNull();
    expect(parseCustomEmojiToken("<:kedi:0123>")).toBeNull();
    expect(parseCustomEmojiToken(`<:K:${ID_A}>`)).toBeNull();
  });
  it("buildEmojiToken round-trips", () => {
    const ref = { name: "kedi", id: ID_A, animated: true };
    expect(parseCustomEmojiToken(buildEmojiToken(ref))).toEqual(ref);
  });
  it("toReactionKey drops the name", () => {
    expect(toReactionKey(`<a:kedi:${ID_A}>`)).toBe(`<a:${ID_A}>`);
    expect(toReactionKey(`<:kedi:${ID_A}>`)).toBe(`<:${ID_A}>`);
  });
  it("toReactionKey passes unicode through", () => {
    expect(toReactionKey("👍")).toBe("👍");
    expect(toReactionKey("👨‍👩‍👧")).toBe("👨‍👩‍👧");
  });
  it("parseReactionKey", () => {
    expect(parseReactionKey(`<:${ID_A}>`)).toEqual({ custom: true, id: ID_A, animated: false });
    expect(parseReactionKey(`<a:${ID_A}>`)).toEqual({ custom: true, id: ID_A, animated: true });
    expect(parseReactionKey("🔥")).toEqual({ custom: false, emoji: "🔥" });
    expect(parseReactionKey(`<:kedi:${ID_A}>`)).toEqual({ custom: false, emoji: `<:kedi:${ID_A}>` });
  });
  it("URLs are deterministic", () => {
    expect(emojiStaticUrl(ID_A)).toBe(`/api/uploads/emojis/${ID_A}.png`);
    expect(emojiAnimatedUrl(ID_A)).toBe(`/api/uploads/emojis/${ID_A}.gif`);
  });
});

describe("convertEmojiShortcodes", () => {
  const byServer = {
    s1: [emoji(ID_A, "s1", "kedi")],
    s2: [emoji(ID_B, "s2", "kedi", true), emoji(ID_C, "s2", "kopek")],
  };

  it("current server wins over other servers", () => {
    expect(convertEmojiShortcodes("hi :kedi:", [], byServer, "s1")).toBe(`hi <:kedi:${ID_A}>`);
    expect(convertEmojiShortcodes("hi :kedi:", [], byServer, "s2")).toBe(`hi <a:kedi:${ID_B}>`);
  });
  it("other member servers are used in ascending id order", () => {
    expect(convertEmojiShortcodes(":kedi: :kopek:", [], byServer, null)).toBe(
      `<:kedi:${ID_A}> <:kopek:${ID_C}>`,
    );
  });
  it("explicit selection wins over everything", () => {
    const sel = [{ name: "kedi", id: ID_B, animated: true }];
    expect(convertEmojiShortcodes(":kedi:", sel, byServer, "s1")).toBe(`<a:kedi:${ID_B}>`);
  });
  it("unknown names stay as typed", () => {
    expect(convertEmojiShortcodes(":yok: :kedi:", [], byServer, "s1")).toBe(`:yok: <:kedi:${ID_A}>`);
  });
  it("does not convert inside inline code or fenced blocks", () => {
    expect(convertEmojiShortcodes("`:kedi:` :kedi:", [], byServer, "s1")).toBe(
      `\`:kedi:\` <:kedi:${ID_A}>`,
    );
    expect(convertEmojiShortcodes("```\n:kedi:\n```", [], byServer, "s1")).toBe("```\n:kedi:\n```");
  });
  it("does not convert inside URLs", () => {
    const url = "https://a.com/x:kedi:y";
    expect(convertEmojiShortcodes(url, [], byServer, "s1")).toBe(url);
  });
  it("leaves existing tokens alone (no double conversion)", () => {
    const tok = `<:kedi:${ID_A}>`;
    expect(convertEmojiShortcodes(tok, [], byServer, "s1")).toBe(tok);
  });
  it("ignores shortcodes glued to a word (times like 12:30:45)", () => {
    const byNum = { s1: [emoji(ID_A, "s1", "30")] };
    expect(convertEmojiShortcodes("12:30:45", [], byNum, "s1")).toBe("12:30:45");
  });
});

describe("plainPreview", () => {
  it("custom tokens become :name:", () => {
    expect(plainPreview(`hi <a:kedi:${ID_A}>`)).toBe("hi :kedi:");
  });
  it("strips markdown markers", () => {
    expect(plainPreview("**bold** and *it* `code`")).toBe("bold and it code");
  });
  it("masks spoiler content", () => {
    expect(plainPreview("the end: ||he dies||")).toBe("the end: ▒▒▒");
  });
  it("null / empty → empty string", () => {
    expect(plainPreview(null)).toBe("");
    expect(plainPreview("")).toBe("");
  });
  it("a whole-message sticker token becomes [name] (Faz D2)", () => {
    expect(plainPreview(`<sticker:kedi:${ID_A}>`)).toBe("[kedi]");
    expect(plainPreview(`  <sticker:a:kedi:${ID_A}>  `)).toBe("[kedi]");
  });
  it("a sticker token inside other text stays as-is", () => {
    expect(plainPreview(`look <sticker:kedi:${ID_A}>`)).toBe(`look <sticker:kedi:${ID_A}>`);
  });
});
