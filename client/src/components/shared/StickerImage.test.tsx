import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const motion = { reduced: false };

vi.mock("../../hooks/useReducedMotion", () => ({
  useReducedMotion: () => motion.reduced,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) =>
      key === "stickerAlt"
        ? `Sticker: ${opts?.name ?? ""}`
        : key === "stickerFallback"
          ? `[${opts?.name ?? ""}]`
          : key,
    i18n: { language: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import StickerImage from "./StickerImage";

const ID = "0123456789abcdef";

beforeEach(() => {
  motion.reduced = false;
});

describe("StickerImage", () => {
  it("renders the deterministic static URL with alt/title from name", () => {
    render(<StickerImage id={ID} name="kedi" animated={false} />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toContain(`/api/uploads/stickers/${ID}.png`);
    expect(img).toHaveAttribute("alt", "Sticker: kedi");
    expect(img).toHaveAttribute("title", "kedi");
    expect(img).toHaveAttribute("draggable", "false");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveClass("msg-sticker-message");
  });

  it("animated plays the GIF by default", () => {
    render(<StickerImage id={ID} name="kedi" animated />);
    expect(screen.getByRole("img").getAttribute("src")).toContain(`/api/uploads/stickers/${ID}.gif`);
  });

  it("`still` always shows the PNG", () => {
    render(<StickerImage id={ID} name="kedi" animated still size="picker" />);
    expect(screen.getByRole("img").getAttribute("src")).toContain(`${ID}.png`);
  });

  it("reduced motion shows the PNG and plays the GIF on hover", () => {
    motion.reduced = true;
    render(<StickerImage id={ID} name="kedi" animated />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toContain(`${ID}.png`);
    fireEvent.mouseEnter(img);
    expect(screen.getByRole("img").getAttribute("src")).toContain(`${ID}.gif`);
    fireEvent.mouseLeave(screen.getByRole("img"));
    expect(screen.getByRole("img").getAttribute("src")).toContain(`${ID}.png`);
  });

  it("an invalid id never reaches a URL (text fallback, no img)", () => {
    render(<StickerImage id="../../etc/passwd" name="kedi" animated={false} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("[kedi]")).toBeInTheDocument();
  });

  it("uppercase id → fallback", () => {
    render(<StickerImage id={ID.toUpperCase()} name="kedi" animated={false} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("onError falls back to [name] once (no retry loop)", () => {
    render(<StickerImage id={ID} name="kedi" animated={false} />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("[kedi]")).toBeInTheDocument();
  });
});
