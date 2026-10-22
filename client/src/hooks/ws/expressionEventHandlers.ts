/**
 * Expression-domain WS event handlers (Faz D1, Sözleşme §7).
 * Handles: server_emoji_create / server_emoji_update / server_emoji_delete,
 * and (Faz D2) server_sticker_create / server_sticker_update / server_sticker_delete.
 *
 * Kept in its own module (not systemEventHandlers) so the Faz A/B handler
 * files stay untouched; wired into useWebSocket's routeEvent chain.
 */

import { useEmojiStore } from "../../stores/emojiStore";
import { useStickerStore } from "../../stores/stickerStore";
import type { WSMessage } from "../../types";

export function handleExpressionEvent(msg: WSMessage): boolean {
  switch (msg.op) {
    case "server_emoji_create":
      useEmojiStore.getState().handleCreate(msg.d);
      return true;
    case "server_emoji_update":
      useEmojiStore.getState().handleUpdate(msg.d);
      return true;
    case "server_emoji_delete":
      useEmojiStore.getState().handleDelete(msg.d);
      return true;
    case "server_sticker_create":
      useStickerStore.getState().handleCreate(msg.d);
      return true;
    case "server_sticker_update":
      useStickerStore.getState().handleUpdate(msg.d);
      return true;
    case "server_sticker_delete":
      useStickerStore.getState().handleDelete(msg.d);
      return true;
    default:
      return false;
  }
}
