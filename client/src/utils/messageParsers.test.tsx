import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) =>
      key === "customEmojiAlt" ? `:${opts?.name ?? ""}:` : key,
    i18n: { language: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("../components/chat/InviteCard", () => ({
  default: ({ code }: { code: string }) => <span data-testid="invite-card">{code}</span>,
}));

vi.mock("../hooks/useReducedMotion", () => ({
  useReducedMotion: () => false,
}));

vi.mock("../stores/accessibilityStore", () => ({
  useAccessibilityStore: (selector: (state: { stickerAnimation: string }) => unknown) =>
    selector({ stickerAnimation: "always" }),
}));

import { getMessagePreviewUrls, renderMessageContent } from "./messageParsers";

const ID = "0123456789abcdef";
const roles = [{ id: "r1", name: "Mods", color: "#ff0000", position: 1 }];
const members = [{ id: "u1", username: "ali", display_name: "Ali V" }];

function renderText(text: string) {
  return render(<div data-testid="root">{renderMessageContent(text, roles, members)}</div>);
}

describe("renderMessageContent — custom emoji", () => {
  it("renders an img with deterministic src and :name: alt", () => {
    renderText(`hi <:kedi:${ID}>`);
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toContain(`/api/uploads/emojis/${ID}.png`);
    expect(img).toHaveAttribute("alt", ":kedi:");
  });

  it("an unknown id still uses the deterministic URL (no lookup needed)", () => {
    renderText(`<a:nope:ffffffffffffffff>`);
    expect(screen.getByRole("img").getAttribute("src")).toContain("/api/uploads/emojis/ffffffffffffffff.gif");
  });

  it("uppercase / malformed tokens stay plain text", () => {
    renderText(`<:kedi:${ID.toUpperCase()}>`);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("root").textContent).toBe(`<:kedi:${ID.toUpperCase()}>`);
  });

  it("emoji-only messages get the jumbo wrapper", () => {
    const { container } = renderText(`<:a1:${ID}> <:b2:${ID}>`);
    expect(container.querySelector(".msg-emoji-jumbo")).not.toBeNull();
  });

  it("mixed text does not go jumbo", () => {
    const { container } = renderText(`hey <:a1:${ID}>`);
    expect(container.querySelector(".msg-emoji-jumbo")).toBeNull();
  });
});

describe("renderMessageContent — stickers (Faz D2)", () => {
  it("a whole-message sticker token renders one sticker img with the deterministic PNG", () => {
    const { container } = renderText(`  <sticker:kedi:${ID}>  `);
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("src")).toContain(`/api/uploads/stickers/${ID}.png`);
    expect(imgs[0]).toHaveClass("msg-sticker");
    expect(container.querySelector("button.msg-sticker-btn")).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("the a: flag uses the animated GIF URL", () => {
    renderText(`<sticker:a:kedi:${ID}>`);
    expect(screen.getByRole("img").getAttribute("src")).toContain(`/api/uploads/stickers/${ID}.gif`);
  });

  it("a sticker token inside other text stays literal text", () => {
    renderText(`look <sticker:kedi:${ID}>`);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("root").textContent).toBe(`look <sticker:kedi:${ID}>`);
  });

  it("an uppercase id stays literal text (no img)", () => {
    renderText(`<sticker:kedi:${ID.toUpperCase()}>`);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByTestId("root").textContent).toBe(`<sticker:kedi:${ID.toUpperCase()}>`);
  });
});

describe("renderMessageContent — clickable custom emoji (Faz D2)", () => {
  it("a custom emoji is wrapped in a popover button", () => {
    const { container } = renderText(`hi <:kedi:${ID}>`);
    const btn = container.querySelector("button.msg-custom-emoji-btn");
    expect(btn).not.toBeNull();
    expect(btn).toHaveAttribute("aria-haspopup", "dialog");
    expect(btn?.querySelector("img")).not.toBeNull();
  });

  it("an emoji button inside a closed spoiler sits in an inert subtree", () => {
    const { container } = renderText(`||<:kedi:${ID}>||`);
    const btn = container.querySelector("button.msg-custom-emoji-btn");
    const content = container.querySelector(".msg-spoiler-content");
    expect(btn).not.toBeNull();
    expect(btn?.closest("[inert]")).toBe(content);
  });
});

describe("renderMessageContent — markdown-lite", () => {
  it("bold / italic / code / code block", () => {
    const { container } = renderText("**b** *i* `c`\n```js\nx\n```");
    expect(container.querySelector("strong")?.textContent).toBe("b");
    expect(container.querySelector("em")?.textContent).toBe("i");
    expect(container.querySelector("code")?.textContent).toBe("c");
    expect(container.querySelector("pre.msg-code-block code")?.textContent).toBe("x");
  });

  it("spoiler is closed (aria-hidden) until clicked", () => {
    const { container } = renderText("a ||secret|| b");
    const spoiler = screen.getByRole("button");
    expect(spoiler).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".msg-spoiler-content")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(spoiler);
    expect(spoiler).toHaveAttribute("aria-expanded", "true");
    expect(spoiler).toHaveAttribute("data-revealed", "true");
    expect(container.querySelector(".msg-spoiler-content")).not.toHaveAttribute("aria-hidden");
  });

  it("a closed spoiler's link is inert (out of tab order) until revealed", () => {
    const { container } = renderText("||https://hidden.example/x||");
    const content = container.querySelector(".msg-spoiler-content");
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(content).toHaveAttribute("inert");
    // An inert subtree is skipped by sequential focus navigation; the
    // nearest inert ancestor is what removes the link from the tab order.
    expect(link?.closest("[inert]")).toBe(content);

    fireEvent.click(screen.getByRole("button"));
    expect(content).not.toHaveAttribute("inert");
    expect(link?.closest("[inert]")).toBeNull();
    link?.focus();
    expect(document.activeElement).toBe(link);
  });

  it("spoiler opens with Enter", () => {
    renderText("||x||");
    const spoiler = screen.getByRole("button");
    fireEvent.keyDown(spoiler, { key: "Enter" });
    expect(spoiler).toHaveAttribute("aria-expanded", "true");
  });

  it("HTML-looking text stays text (no element, no event attribute)", () => {
    const { container } = renderText('<img src=x onerror="alert(1)"> **<script>x</script>**');
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.querySelector("strong")?.textContent).toBe("<script>x</script>");
  });
});

describe("renderMessageContent — existing branches unchanged", () => {
  it("whole-message Klipy URL is still an inline GIF embed", () => {
    const url = "https://static.klipy.com/ii/abc/xyz.gif";
    const { container } = renderText(url);
    const img = container.querySelector("img.msg-gif-embed");
    expect(img).toHaveAttribute("src", url);
  });

  it("user mention / role mention / legacy @name / unknown", () => {
    const { container } = renderText("<@u1> <@&r1> @ali <@zzz>");
    const spans = [...container.querySelectorAll(".msg-mention, .msg-role-mention")].map((s) => s.textContent);
    expect(spans).toEqual(["@Ali V", "@Mods", "@Ali V", "@unknown-user"]);
  });

  it("invite URL becomes an InviteCard", () => {
    renderText("join https://hichat.app/invite/0123456789abcdef");
    expect(screen.getByTestId("invite-card").textContent).toBe("0123456789abcdef");
  });

  it("generic URL becomes a safe link", () => {
    renderText("see https://example.com/a_b_c");
    const a = screen.getByRole("link");
    expect(a).toHaveAttribute("href", "https://example.com/a_b_c");
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
    expect(a).toHaveAttribute("target", "_blank");
  });

  it("null / empty → null", () => {
    expect(renderMessageContent(null, roles, members)).toBeNull();
    expect(renderMessageContent("", roles, members)).toBeNull();
  });
});

describe("getMessagePreviewUrls", () => {
  it("keeps plain URLs, drops invite + Klipy", () => {
    expect(
      getMessagePreviewUrls(
        "https://a.com https://h.app/invite/0123456789abcdef https://static.klipy.com/x.gif",
      ),
    ).toEqual(["https://a.com"]);
  });
  it("excludes URLs inside spoilers and code", () => {
    expect(getMessagePreviewUrls("||https://hidden.com|| `https://code.com` https://shown.com")).toEqual([
      "https://shown.com",
    ]);
    expect(getMessagePreviewUrls("```\nhttps://block.com\n```")).toEqual([]);
  });
  it("still finds URLs inside bold", () => {
    expect(getMessagePreviewUrls("**see https://a.com now**")).toEqual(["https://a.com"]);
  });
  it("de-duplicates and caps at 5", () => {
    const text = Array.from({ length: 8 }, (_, i) => `https://u${i}.com`).join(" ") + " https://u0.com";
    expect(getMessagePreviewUrls(text)).toHaveLength(5);
  });
});
