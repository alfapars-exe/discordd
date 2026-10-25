import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const motion = { reduced: false };
const accessibility = { disableAnimatedEmoji: false };

vi.mock("../../hooks/useReducedMotion", () => ({
  useReducedMotion: () => motion.reduced,
}));

vi.mock("../../stores/accessibilityStore", () => ({
  useAccessibilityStore: (selector: (state: typeof accessibility) => unknown) => selector(accessibility),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) =>
      key === "customEmojiAlt" ? `:${opts?.name ?? ""}:` : key,
    i18n: { language: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import CustomEmoji from "./CustomEmoji";

const ID = "0123456789abcdef";

beforeEach(() => {
  motion.reduced = false;
  accessibility.disableAnimatedEmoji = false;
});

describe("CustomEmoji", () => {
  it("renders the deterministic static URL with :name: alt/title", () => {
    render(<CustomEmoji id={ID} name="kedi" animated={false} />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toContain(`/api/uploads/emojis/${ID}.png`);
    expect(img).toHaveAttribute("alt", ":kedi:");
    expect(img).toHaveAttribute("title", ":kedi:");
    expect(img).toHaveAttribute("draggable", "false");
  });

  it("animated plays the GIF by default", () => {
    render(<CustomEmoji id={ID} name="kedi" animated />);
    expect(screen.getByRole("img").getAttribute("src")).toContain(`${ID}.gif`);
  });

  it("reduced motion shows the static PNG and plays on hover", () => {
    motion.reduced = true;
    render(<CustomEmoji id={ID} name="kedi" animated />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toContain(`${ID}.png`);
    fireEvent.mouseEnter(img);
    expect(screen.getByRole("img").getAttribute("src")).toContain(`${ID}.gif`);
    fireEvent.mouseLeave(screen.getByRole("img"));
    expect(screen.getByRole("img").getAttribute("src")).toContain(`${ID}.png`);
  });

  it("`still` always shows the PNG", () => {
    render(<CustomEmoji id={ID} name="kedi" animated still />);
    expect(screen.getByRole("img").getAttribute("src")).toContain(`${ID}.png`);
  });

  it("never plays or fetches the GIF when animated emoji are disabled", () => {
    accessibility.disableAnimatedEmoji = true;
    render(<CustomEmoji id={ID} name="kedi" animated />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toContain(`${ID}.png`);
    fireEvent.mouseEnter(img);
    expect(screen.getByRole("img").getAttribute("src")).toContain(`${ID}.png`);
  });

  it("falls back to :name: text exactly once on load error", () => {
    const { container } = render(<CustomEmoji id={ID} name="kedi" animated={false} />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.textContent).toBe(":kedi:");
  });

  it("never builds a URL from a malformed id", () => {
    const { container } = render(<CustomEmoji id="../../etc" name="x1" animated={false} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.textContent).toBe(":x1:");
  });
});
