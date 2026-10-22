/**
 * Cosmetics types (Faz G, Sözleşme §8).
 *
 * `asset` is always `unknown` on the wire — it must go through
 * `parseCosmeticAsset` (utils/cosmetics.ts) before anything renders it.
 */

export type CosmeticType = "avatar_frame" | "nameplate" | "name_style" | "profile_theme" | "profile_effect";
export type CosmeticFormat = "svg" | "css" | "raster";
export type FrameKey = "aurora" | "ember" | "frost" | "sakura" | "circuit" | "laurel";
export type NameplatePattern = "none" | "dots" | "stripes" | "grain";
export type NameFont = "default" | "bold" | "mono";
export type ProfileEffectKind = "sparkle" | "snow" | "glow" | "petals" | "confetti" | "stars";

export type FrameAsset = { v: 1; frame: FrameKey };
export type RasterFrameAsset = { v: 1; url: string; animated_url?: string };
export type NameplateAsset = { v: 1; stops: string[]; angle: number; pattern: NameplatePattern };
export type NameStyleAsset = { v: 1; font: NameFont; stops: string[]; angle: number };
export type ProfileThemeAsset = { v: 1; accent: string; gradient: [string, string]; angle: number };
export type ProfileEffectAsset = { v: 1; effect: ProfileEffectKind; color: string };

export type EquippedCosmetic = { item_id: string; format: CosmeticFormat; animated: boolean; asset: unknown };
export type CosmeticSlots = Partial<Record<CosmeticType, EquippedCosmetic>>;

export type CosmeticItem = {
  id: string;
  server_id: string | null;
  type: CosmeticType;
  format: CosmeticFormat;
  name: string;
  description: string | null;
  asset: unknown;
  animated: boolean;
  availability: "free" | "granted";
  created_at: string;
};

export type CosmeticGrant = {
  item_id: string;
  server_id: string;
  granted_by: { id: string; username: string; display_name: string | null } | null;
  reason: string;
  granted_at: string;
};

export type MyCosmetics = {
  items: CosmeticItem[];
  grants: CosmeticGrant[];
  equipped: { global: CosmeticSlots; servers: Record<string, CosmeticSlots> };
  plain_server_ids: string[];
};

export type EquipRequest = { scope: string; slots: Partial<Record<CosmeticType, string | null>> };

export type CosmeticsUpdateEvent = {
  user_id: string;
  server_id: string | null;
  slots: CosmeticSlots;
  plain: boolean;
};
