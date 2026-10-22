import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ServerSticker } from "../../types/expression";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "tr" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("../../hooks/useReducedMotion", () => ({
  useReducedMotion: () => false,
}));

function sticker(id: string, serverId: string, name: string, display: string, tags: string[] = [], animated = false): ServerSticker {
  return {
    id,
    server_id: serverId,
    name,
    display_name: display,
    description: "",
    tags,
    animated,
    url: `/api/uploads/stickers/${id}.png`,
    animated_url: animated ? `/api/uploads/stickers/${id}.gif` : null,
    copyable: false,
    cloned_from: null,
    created_by: null,
    created_at: "2026-10-22T10:00:00Z",
  };
}

const S1 = sticker("aaaaaaaaaaaaaaaa", "s1", "iyi_gunler", "İyi Günler", ["selam"]);
const S2 = sticker("bbbbbbbbbbbbbbbb", "s1", "kedi", "Kedi", [], true);
const S3 = sticker("cccccccccccccccc", "s2", "isik", "Işık");

vi.mock("../../hooks/useStickerCatalog", () => ({
  useStickerCatalog: () => ({
    status: "ready",
    byServer: {},
    byId: {},
    servers: [
      { id: "s1", name: "Server One", stickers: [S1, S2] },
      { id: "s2", name: "Server Two", stickers: [S3] },
    ],
  }),
}));

import StickerPicker from "./StickerPicker";

describe("StickerPicker", () => {
  it("groups by server and shows static thumbnails only", () => {
    render(<StickerPicker onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Server One")).toBeInTheDocument();
    expect(screen.getByText("Server Two")).toBeInTheDocument();
    const imgs = screen.getAllByRole("img");
    expect(imgs).toHaveLength(3);
    for (const img of imgs) expect(img.getAttribute("src")).toMatch(/\.png$/);
  });

  it("selecting a sticker hands over its whole-message token", () => {
    const onSelect = vi.fn();
    render(<StickerPicker onSelect={onSelect} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Kedi" }));
    expect(onSelect).toHaveBeenCalledWith("<sticker:a:kedi:bbbbbbbbbbbbbbbb>");
    fireEvent.click(screen.getByRole("button", { name: "İyi Günler" }));
    expect(onSelect).toHaveBeenLastCalledWith("<sticker:iyi_gunler:aaaaaaaaaaaaaaaa>");
  });

  it("search folds Turkish case: 'i' and 'İ' both find İyi Günler, 'ı' finds Işık", () => {
    render(<StickerPicker onSelect={() => {}} onClose={() => {}} />);
    const search = screen.getByRole("textbox");
    fireEvent.change(search, { target: { value: "İ" } });
    expect(screen.getByRole("button", { name: "İyi Günler" })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "iyi" } });
    expect(screen.getByRole("button", { name: "İyi Günler" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kedi" })).toBeNull();
    expect(screen.queryByText("Server Two")).toBeNull();
    fireEvent.change(search, { target: { value: "ışı" } });
    expect(screen.getByRole("button", { name: "Işık" })).toBeInTheDocument();
    expect(screen.queryByText("Server One")).toBeNull();
  });

  it("searches tags and shows the empty state", () => {
    render(<StickerPicker onSelect={() => {}} onClose={() => {}} />);
    const search = screen.getByRole("textbox");
    fireEvent.change(search, { target: { value: "SELAM" } });
    expect(screen.getByRole("button", { name: "İyi Günler" })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("noStickers")).toBeInTheDocument();
  });

  it("Escape closes", () => {
    const onClose = vi.fn();
    render(<StickerPicker onSelect={() => {}} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
