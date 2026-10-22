import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServerEmoji, ServerSticker } from "../../types/expression";
import type { WSMessage } from "../../types";

vi.mock("../../stores/emojiStore", () => {
  const handleCreate = vi.fn();
  const handleUpdate = vi.fn();
  const handleDelete = vi.fn();
  return {
    useEmojiStore: {
      getState: () => ({ handleCreate, handleUpdate, handleDelete }),
    },
  };
});

vi.mock("../../stores/stickerStore", () => {
  const handleCreate = vi.fn();
  const handleUpdate = vi.fn();
  const handleDelete = vi.fn();
  return {
    useStickerStore: {
      getState: () => ({ handleCreate, handleUpdate, handleDelete }),
    },
  };
});

import { useEmojiStore } from "../../stores/emojiStore";
import { useStickerStore } from "../../stores/stickerStore";
import { handleExpressionEvent } from "./expressionEventHandlers";

const E: ServerEmoji = {
  id: "0123456789abcdef",
  server_id: "s1",
  name: "kedi",
  display_name: "Kedi",
  animated: false,
  url: "/api/uploads/emojis/0123456789abcdef.png",
  animated_url: null,
  copyable: false,
  cloned_from: null,
  created_by: "u1",
  created_at: "2026-10-22T10:00:00Z",
};

const store = useEmojiStore.getState();
const stickers = useStickerStore.getState();

const S: ServerSticker = {
  id: "fedcba9876543210",
  server_id: "s1",
  name: "mutlu_kedi",
  display_name: "Mutlu Kedi",
  description: "",
  tags: ["kedi"],
  animated: false,
  url: "/api/uploads/stickers/fedcba9876543210.png",
  animated_url: null,
  copyable: true,
  cloned_from: null,
  created_by: "u1",
  created_at: "2026-10-22T10:00:00Z",
};

beforeEach(() => vi.clearAllMocks());

describe("handleExpressionEvent", () => {
  it("routes server_emoji_create", () => {
    expect(handleExpressionEvent({ op: "server_emoji_create", d: E } as WSMessage)).toBe(true);
    expect(store.handleCreate).toHaveBeenCalledWith(E);
  });
  it("routes server_emoji_update", () => {
    expect(handleExpressionEvent({ op: "server_emoji_update", d: E } as WSMessage)).toBe(true);
    expect(store.handleUpdate).toHaveBeenCalledWith(E);
  });
  it("routes server_emoji_delete", () => {
    const d = { id: E.id, server_id: "s1" };
    expect(handleExpressionEvent({ op: "server_emoji_delete", d } as WSMessage)).toBe(true);
    expect(store.handleDelete).toHaveBeenCalledWith(d);
  });
  it("routes server_sticker_create / update / delete to stickerStore (Faz D2)", () => {
    expect(handleExpressionEvent({ op: "server_sticker_create", d: S } as WSMessage)).toBe(true);
    expect(stickers.handleCreate).toHaveBeenCalledWith(S);
    expect(handleExpressionEvent({ op: "server_sticker_update", d: S } as WSMessage)).toBe(true);
    expect(stickers.handleUpdate).toHaveBeenCalledWith(S);
    const d = { id: S.id, server_id: "s1" };
    expect(handleExpressionEvent({ op: "server_sticker_delete", d } as WSMessage)).toBe(true);
    expect(stickers.handleDelete).toHaveBeenCalledWith(d);
    expect(store.handleCreate).not.toHaveBeenCalled();
  });
  it("returns false for unrelated ops", () => {
    expect(handleExpressionEvent({ op: "channel_delete", d: { id: "c" } } as WSMessage)).toBe(false);
    expect(store.handleCreate).not.toHaveBeenCalled();
    expect(stickers.handleCreate).not.toHaveBeenCalled();
  });
});
