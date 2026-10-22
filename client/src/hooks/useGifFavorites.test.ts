import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { GifResult } from "../api/gif";

vi.mock("../api/preferences", () => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn().mockResolvedValue({ success: true }),
}));

import { usePreferencesStore } from "../stores/preferencesStore";
import {
  GIF_FAVORITES_KEY,
  MAX_GIF_FAVORITES,
  sanitizeGifFavorites,
  useGifFavorites,
} from "./useGifFavorites";

function gif(id: string, host = "static.klipy.com"): GifResult {
  return {
    id,
    title: `gif ${id}`,
    url: `https://${host}/md/${id}.gif`,
    preview_url: `https://${host}/xs/${id}.gif`,
    width: 100,
    height: 80,
  };
}

beforeEach(() => {
  usePreferencesStore.setState({ data: {}, isLoaded: true });
});

describe("sanitizeGifFavorites", () => {
  it("rejects non-Klipy url or preview_url", () => {
    const evil = { ...gif("1"), preview_url: "https://evil.example/pixel.gif" };
    expect(sanitizeGifFavorites([gif("ok"), gif("2", "evil.example"), evil]).map((g) => g.id)).toEqual(["ok"]);
  });
  it("de-duplicates by id and caps at 50", () => {
    const many = Array.from({ length: 70 }, (_, i) => gif(String(i)));
    expect(sanitizeGifFavorites([gif("0"), ...many])).toHaveLength(MAX_GIF_FAVORITES);
    expect(sanitizeGifFavorites([gif("a"), gif("a")])).toHaveLength(1);
  });
  it("ignores garbage", () => {
    expect(sanitizeGifFavorites("nope")).toEqual([]);
    expect(sanitizeGifFavorites([null, 1, { id: 2 }])).toEqual([]);
  });
});

describe("useGifFavorites", () => {
  it("toggle adds (newest first) and removes", () => {
    const { result } = renderHook(() => useGifFavorites());
    act(() => {
      expect(result.current.toggle(gif("a"))).toBe("added");
    });
    act(() => {
      expect(result.current.toggle(gif("b"))).toBe("added");
    });
    expect(result.current.favorites.map((g) => g.id)).toEqual(["b", "a"]);
    expect(result.current.isFavorite("a")).toBe(true);
    act(() => {
      expect(result.current.toggle(gif("a"))).toBe("removed");
    });
    expect(result.current.isFavorite("a")).toBe(false);
    expect(usePreferencesStore.getState().data[GIF_FAVORITES_KEY]).toHaveLength(1);
  });

  it("refuses non-Klipy GIFs", () => {
    const { result } = renderHook(() => useGifFavorites());
    act(() => {
      expect(result.current.toggle(gif("x", "evil.example"))).toBe("invalid");
    });
    expect(result.current.favorites).toEqual([]);
  });

  it("reports full at 50", () => {
    usePreferencesStore.setState({
      data: { [GIF_FAVORITES_KEY]: Array.from({ length: 50 }, (_, i) => gif(String(i))) },
    });
    const { result } = renderHook(() => useGifFavorites());
    act(() => {
      expect(result.current.toggle(gif("new"))).toBe("full");
    });
    expect(result.current.favorites).toHaveLength(50);
  });
});
