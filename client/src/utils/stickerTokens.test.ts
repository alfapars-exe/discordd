import { describe, it, expect } from "vitest";
import {
  buildStickerToken,
  isValidStickerDescription,
  matchStickerQuery,
  normalizeStickerTags,
  parseStickerToken,
  parseTagInput,
  stickerAnimatedUrl,
  stickerStaticUrl,
} from "./stickerTokens";

const ID = "0123456789abcdef";
const RLO = String.fromCharCode(0x202e);

describe("parseStickerToken", () => {
  it("parses a static token", () => {
    expect(parseStickerToken(`<sticker:kedi:${ID}>`)).toEqual({ name: "kedi", id: ID, animated: false });
  });
  it("parses an animated token", () => {
    expect(parseStickerToken(`<sticker:a:mutlu_kedi:${ID}>`)).toEqual({
      name: "mutlu_kedi",
      id: ID,
      animated: true,
    });
  });
  it("trims surrounding whitespace (whole-message check)", () => {
    expect(parseStickerToken(`  <sticker:kedi:${ID}>\n`)?.id).toBe(ID);
  });
  it("rejects invalid / uppercase ids", () => {
    expect(parseStickerToken(`<sticker:kedi:${ID.toUpperCase()}>`)).toBeNull();
    expect(parseStickerToken(`<sticker:kedi:0123>`)).toBeNull();
    expect(parseStickerToken(`<sticker:kedi:../../etc/passwd0>`)).toBeNull();
  });
  it("rejects invalid names", () => {
    expect(parseStickerToken(`<sticker:k:${ID}>`)).toBeNull();
    expect(parseStickerToken(`<sticker:Kedi:${ID}>`)).toBeNull();
  });
  it("rejects extra text around the token (no inline stickers)", () => {
    expect(parseStickerToken(`look <sticker:kedi:${ID}>`)).toBeNull();
    expect(parseStickerToken(`<sticker:kedi:${ID}> <sticker:kedi:${ID}>`)).toBeNull();
  });
  it("is not confused with custom emoji tokens", () => {
    expect(parseStickerToken(`<:kedi:${ID}>`)).toBeNull();
    expect(parseStickerToken(`<a:kedi:${ID}>`)).toBeNull();
  });
  it("null / empty → null", () => {
    expect(parseStickerToken(null)).toBeNull();
    expect(parseStickerToken("")).toBeNull();
  });
});

describe("buildStickerToken", () => {
  it("round-trips static and animated", () => {
    for (const ref of [
      { name: "kedi", id: ID, animated: false },
      { name: "a1", id: ID, animated: true },
    ]) {
      expect(parseStickerToken(buildStickerToken(ref))).toEqual(ref);
    }
    expect(buildStickerToken({ name: "kedi", id: ID, animated: true })).toBe(`<sticker:a:kedi:${ID}>`);
  });
});

describe("URLs", () => {
  it("are deterministic", () => {
    expect(stickerStaticUrl(ID)).toBe(`/api/uploads/stickers/${ID}.png`);
    expect(stickerAnimatedUrl(ID)).toBe(`/api/uploads/stickers/${ID}.gif`);
  });
});

describe("normalizeStickerTags — shared Go/TS vectors (Sözleşme §6)", () => {
  it('["kedi"," Kedi ","köpek"] → ["kedi","köpek"]', () => {
    expect(normalizeStickerTags(["kedi", " Kedi ", "köpek"])).toEqual(["kedi", "köpek"]);
  });
  it('["", " "] → []', () => {
    expect(normalizeStickerTags(["", " "])).toEqual([]);
  });
  it('["a,b"] → invalid', () => {
    expect(normalizeStickerTags(["a,b"])).toBeNull();
  });
  it("6 distinct tags → invalid", () => {
    expect(normalizeStickerTags(["a", "b", "c", "d", "e", "f"])).toBeNull();
    expect(normalizeStickerTags(["a", "b", "c", "d", "e"])).toHaveLength(5);
  });
  it('["x"*21] → invalid (20 is fine)', () => {
    expect(normalizeStickerTags(["x".repeat(21)])).toBeNull();
    expect(normalizeStickerTags(["x".repeat(20)])).toEqual(["x".repeat(20)]);
  });
  it('["\\u202Eab"] → invalid', () => {
    expect(normalizeStickerTags([`${RLO}ab`])).toBeNull();
  });
  it('["Şeker","şeker"] → ["Şeker"]', () => {
    expect(normalizeStickerTags(["Şeker", "şeker"])).toEqual(["Şeker"]);
  });
  it("duplicates beyond the cap collapse before the >5 check", () => {
    expect(normalizeStickerTags(["a", "A", "b", "c", "d", "e"])).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("parseTagInput splits on commas", () => {
    expect(parseTagInput("kedi, mutlu , ")).toEqual(["kedi", "mutlu"]);
    expect(parseTagInput("")).toEqual([]);
  });
});

describe("isValidStickerDescription", () => {
  it("accepts empty and ≤100 runes, rejects 101 / newline / bidi", () => {
    expect(isValidStickerDescription("")).toBe(true);
    expect(isValidStickerDescription("ş".repeat(100))).toBe(true);
    expect(isValidStickerDescription("ş".repeat(101))).toBe(false);
    expect(isValidStickerDescription("a\nb")).toBe(false);
    expect(isValidStickerDescription(`a${RLO}b`)).toBe(false);
  });
});

describe("matchStickerQuery (tr-TR)", () => {
  const st = { name: "iyi_gunler", display_name: "İyi Günler", tags: ["Selam", "IŞIK"] };
  it("empty query matches", () => {
    expect(matchStickerQuery(st, "  ")).toBe(true);
  });
  it("display name with Turkish dotted İ", () => {
    expect(matchStickerQuery(st, "iyi")).toBe(true);
    expect(matchStickerQuery(st, "İYİ")).toBe(true);
  });
  it("shortcode and tags", () => {
    expect(matchStickerQuery(st, "gunler")).toBe(true);
    expect(matchStickerQuery(st, "selam")).toBe(true);
    expect(matchStickerQuery(st, "ışık")).toBe(true);
  });
  it("no match", () => {
    expect(matchStickerQuery(st, "köpek")).toBe(false);
  });
});
