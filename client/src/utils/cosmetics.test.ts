import { describe, it, expect } from "vitest";
import {
  EMPTY_SLOTS,
  parseCosmeticAsset,
  parseCosmeticSlots,
  resolveSlots,
  slotsEqual,
  cssVarsForNameplate,
} from "./cosmetics";
import type { CosmeticSlots, EquippedCosmetic } from "../types/cosmetics";

// Sözleşme §3 vectors — identical to the Go models/cosmetics_test.go set.
describe("parseCosmeticAsset — valid vectors", () => {
  it("svg frame", () => {
    const p = parseCosmeticAsset("avatar_frame", "svg", { v: 1, frame: "aurora" });
    expect(JSON.stringify(p?.asset)).toBe('{"v":1,"frame":"aurora"}');
  });

  it("nameplate canonicalises hex to lower case", () => {
    const p = parseCosmeticAsset("nameplate", "css", {
      v: 1,
      stops: ["#2B1A4A", "#6a2c70"],
      angle: 135,
      pattern: "none",
    });
    expect(JSON.stringify(p?.asset)).toBe('{"v":1,"stops":["#2b1a4a","#6a2c70"],"angle":135,"pattern":"none"}');
  });

  it("3-stop nameplate with pattern", () => {
    const p = parseCosmeticAsset("nameplate", "css", {
      v: 1,
      stops: ["#000000", "#111111", "#222222"],
      angle: 0,
      pattern: "dots",
    });
    expect(p?.kind).toBe("nameplate");
  });

  it("name style 1 stop, angle 359", () => {
    const p = parseCosmeticAsset("name_style", "css", { v: 1, font: "mono", stops: ["#ffffff"], angle: 359 });
    expect(JSON.stringify(p?.asset)).toBe('{"v":1,"font":"mono","stops":["#ffffff"],"angle":359}');
  });

  it("profile theme", () => {
    const p = parseCosmeticAsset("profile_theme", "css", {
      v: 1,
      accent: "#7c5cff",
      gradient: ["#1a1033", "#3a1c71"],
      angle: 160,
    });
    expect(JSON.stringify(p?.asset)).toBe('{"v":1,"accent":"#7c5cff","gradient":["#1a1033","#3a1c71"],"angle":160}');
  });

  it("profile effect", () => {
    const p = parseCosmeticAsset("profile_effect", "css", { v: 1, effect: "snow", color: "#ffffff" });
    expect(JSON.stringify(p?.asset)).toBe('{"v":1,"effect":"snow","color":"#ffffff"}');
  });

  it("canonical key order regardless of input order", () => {
    const p = parseCosmeticAsset("nameplate", "css", { pattern: "grain", angle: 90, stops: ["#AABBCC", "#000000"], v: 1 });
    expect(JSON.stringify(p?.asset)).toBe('{"v":1,"stops":["#aabbcc","#000000"],"angle":90,"pattern":"grain"}');
  });

  it("accepts a raw JSON string too", () => {
    const p = parseCosmeticAsset("avatar_frame", "svg", '{"v":1,"frame":"laurel"}');
    expect(p?.kind).toBe("frame_svg");
  });

  it("server-made raster frame with exact upload URLs", () => {
    const p = parseCosmeticAsset("avatar_frame", "raster", {
      v: 1,
      url: "/api/uploads/cosmetics/0123456789abcdef.png",
      animated_url: "/api/uploads/cosmetics/0123456789abcdef.gif",
    });
    expect(p?.kind).toBe("frame_raster");
  });
});

describe("parseCosmeticAsset — invalid vectors", () => {
  const np = (over: Record<string, unknown>) => ({ v: 1, stops: ["#000000", "#111111"], angle: 0, pattern: "none", ...over });
  const cases: Array<[string, string, string, unknown]> = [
    ["v:2", "avatar_frame", "svg", { v: 2, frame: "aurora" }],
    ["v missing", "avatar_frame", "svg", { frame: "aurora" }],
    ['v "1"', "avatar_frame", "svg", { v: "1", frame: "aurora" }],
    ["frame evil", "avatar_frame", "svg", { v: 1, frame: "evil" }],
    ["svg frame under nameplate", "nameplate", "svg", { v: 1, frame: "aurora" }],
    ["frame asset as nameplate css", "nameplate", "css", { v: 1, frame: "aurora" }],
    ["1 stop nameplate", "nameplate", "css", np({ stops: ["#000000"] })],
    ["4 stop nameplate", "nameplate", "css", np({ stops: ["#000000", "#000000", "#000000", "#000000"] })],
    ["#fff", "nameplate", "css", np({ stops: ["#fff", "#000000"] })],
    ["red", "nameplate", "css", np({ stops: ["red", "#000000"] })],
    ["#12345g", "nameplate", "css", np({ stops: ["#12345g", "#000000"] })],
    ["url(x)", "nameplate", "css", np({ stops: ["url(x)", "#000000"] })],
    ["angle 360", "nameplate", "css", np({ angle: 360 })],
    ["angle -1", "nameplate", "css", np({ angle: -1 })],
    ["angle 1.5", "nameplate", "css", np({ angle: 1.5 })],
    ['angle "90"', "nameplate", "css", np({ angle: "90" })],
    ["pattern zigzag", "nameplate", "css", np({ pattern: "zigzag" })],
    ["font comic", "name_style", "css", { v: 1, font: "comic", stops: ["#ffffff"], angle: 0 }],
    ["3-stop name style", "name_style", "css", { v: 1, font: "bold", stops: ["#ffffff", "#ffffff", "#ffffff"], angle: 0 }],
    ["effect fire", "profile_effect", "css", { v: 1, effect: "fire", color: "#ffffff" }],
    ["unknown field css", "nameplate", "css", np({ css: "x" })],
    ["theme 1-stop gradient", "profile_theme", "css", { v: 1, accent: "#ffffff", gradient: ["#000000"], angle: 0 }],
    ["null", "avatar_frame", "svg", null],
    ["array", "avatar_frame", "svg", [1, 2]],
    ["not JSON", "avatar_frame", "svg", "{not json"],
    ["raster with foreign host", "avatar_frame", "raster", { v: 1, url: "https://evil/x.png" }],
    ["raster with traversal", "avatar_frame", "raster", { v: 1, url: "/api/uploads/cosmetics/../a.png" }],
    ["raster under nameplate", "nameplate", "raster", { v: 1, url: "/api/uploads/cosmetics/0123456789abcdef.png" }],
    ["unknown type", "badge", "css", { v: 1 }],
    ["unknown format", "avatar_frame", "lottie", { v: 1, frame: "aurora" }],
  ];

  for (const [name, type, format, x] of cases) {
    it(name, () => {
      expect(parseCosmeticAsset(type, format, x)).toBeNull();
    });
  }

  it("rejects a 513-byte body", () => {
    const base = '{"v":1,"frame":"aurora"}';
    const padded = base.slice(0, -1) + " ".repeat(513 - base.length) + "}";
    expect(new TextEncoder().encode(padded).length).toBe(513);
    expect(parseCosmeticAsset("avatar_frame", "svg", padded)).toBeNull();
  });
});

const frameSlot = (frame: string): EquippedCosmetic => ({
  item_id: `b_frame_${frame}`,
  format: "svg",
  animated: false,
  asset: { v: 1, frame },
});

describe("parseCosmeticSlots", () => {
  it("keeps valid slots and silently drops invalid / unknown ones", () => {
    const slots = parseCosmeticSlots({
      avatar_frame: frameSlot("aurora"),
      nameplate: { item_id: "x", format: "css", animated: false, asset: { v: 1, stops: ["red"], angle: 0, pattern: "none" } },
      bogus: frameSlot("aurora"),
      profile_effect: { item_id: "e", format: "css", animated: "yes", asset: { v: 1, effect: "snow", color: "#ffffff" } },
    });
    expect(Object.keys(slots)).toEqual(["avatar_frame"]);
  });

  it("returns the shared EMPTY_SLOTS for garbage", () => {
    expect(parseCosmeticSlots(null)).toBe(EMPTY_SLOTS);
    expect(parseCosmeticSlots([])).toBe(EMPTY_SLOTS);
    expect(parseCosmeticSlots({ avatar_frame: frameSlot("evil") })).toBe(EMPTY_SLOTS);
  });

  it("canonicalises the stored asset", () => {
    const slots = parseCosmeticSlots({
      name_style: { item_id: "n", format: "css", animated: false, asset: { angle: 0, stops: ["#FFFFFF"], font: "bold", v: 1 } },
    });
    expect(JSON.stringify(slots.name_style?.asset)).toBe('{"v":1,"font":"bold","stops":["#ffffff"],"angle":0}');
  });
});

describe("resolveSlots (§7)", () => {
  const global: CosmeticSlots = { avatar_frame: frameSlot("aurora"), nameplate: undefined };
  const override: CosmeticSlots = { avatar_frame: frameSlot("ember") };

  it("global context ignores overrides", () => {
    expect(resolveSlots(global, override, { inServer: false, plain: false }).avatar_frame?.item_id).toBe("b_frame_aurora");
  });

  it("server context: override wins per type, global fills the rest", () => {
    const g: CosmeticSlots = {
      avatar_frame: frameSlot("aurora"),
      profile_effect: { item_id: "b_effect_snow", format: "css", animated: true, asset: { v: 1, effect: "snow", color: "#ffffff" } },
    };
    const r = resolveSlots(g, override, { inServer: true, plain: false });
    expect(r.avatar_frame?.item_id).toBe("b_frame_ember");
    expect(r.profile_effect?.item_id).toBe("b_effect_snow");
  });

  it("server context without override falls back to global", () => {
    expect(resolveSlots(global, undefined, { inServer: true, plain: false })).toBe(global);
  });

  it("plain in that server hides everything", () => {
    expect(resolveSlots(global, override, { inServer: true, plain: true })).toBe(EMPTY_SLOTS);
  });
});

describe("slotsEqual + css vars", () => {
  it("compares structurally", () => {
    expect(slotsEqual({ avatar_frame: frameSlot("aurora") }, { avatar_frame: frameSlot("aurora") })).toBe(true);
    expect(slotsEqual({ avatar_frame: frameSlot("aurora") }, { avatar_frame: frameSlot("ember") })).toBe(false);
    expect(slotsEqual(EMPTY_SLOTS, { avatar_frame: frameSlot("aurora") })).toBe(false);
  });

  it("nameplate vars only carry validated tokens", () => {
    const vars = cssVarsForNameplate({ v: 1, stops: ["#000000", "#ffffff"], angle: 45, pattern: "none" });
    expect(vars).toEqual({
      "--cos-np-a": "#000000",
      "--cos-np-b": "#ffffff",
      "--cos-np-c": "#ffffff",
      "--cos-np-angle": "45deg",
    });
  });
});
