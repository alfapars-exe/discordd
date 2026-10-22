/**
 * Expressions (Faz D1/D2) — per-server custom emojis and stickers.
 *
 * Mirrors the server's `ServerEmoji` JSON (Sözleşme §4). `url` is the
 * deterministic static PNG path (`/api/uploads/emojis/{id}.png`);
 * `animated_url` is the GIF copy (`…/{id}.gif`) when `animated` is true.
 */

export type ServerEmoji = {
  id: string;
  server_id: string;
  name: string;
  display_name: string;
  animated: boolean;
  url: string;
  animated_url: string | null;
  copyable: boolean;
  /** Source emoji id when this row is a clone (Faz D2); licence is then locked. */
  cloned_from: string | null;
  created_by: string | null;
  created_at: string;
};

export type ServerEmojiDeleteEvent = { id: string; server_id: string };

/**
 * Per-server sticker (Faz D2, Sözleşme §5). `url` is the static PNG
 * (`/api/uploads/stickers/{id}.png`); `animated_url` the GIF when animated.
 * Sent in messages as the whole-message token `<sticker:name:id>` /
 * `<sticker:a:name:id>` (utils/stickerTokens.ts).
 */
export type ServerSticker = {
  id: string;
  server_id: string;
  name: string;
  display_name: string;
  description: string;
  tags: string[];
  animated: boolean;
  url: string;
  animated_url: string | null;
  copyable: boolean;
  cloned_from: string | null;
  created_by: string | null;
  created_at: string;
};

export type ServerStickerDeleteEvent = { id: string; server_id: string };

export type ExpressionKind = "emoji" | "sticker";
