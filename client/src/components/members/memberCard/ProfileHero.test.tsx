import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ProfileHero from "./ProfileHero";
import { useAccessibilityStore } from "../../../stores/accessibilityStore";

function banner(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".mc-hero-banner");
  if (!el) throw new Error("no banner element");
  return el as HTMLElement;
}

describe("ProfileHero", () => {
  it("renders the banner image (decorative) when bannerUrl is set, ignoring the accent", () => {
    const { container } = render(
      <ProfileHero name="alice" bannerUrl="https://cdn.test/b.png" accentColor="#ff0000" />
    );
    const el = banner(container);
    expect(el.tagName).toBe("IMG");
    expect(el.getAttribute("src")).toBe("https://cdn.test/b.png");
    expect(el.getAttribute("alt")).toBe("");
  });

  it("falls back to a solid accent colour", () => {
    const { container } = render(<ProfileHero name="alice" accentColor="#12abEF" />);
    const el = banner(container);
    expect(el.tagName).toBe("DIV");
    expect(el.classList.contains("mc-hero-accent")).toBe(true);
    expect(el.style.getPropertyValue("--mc-accent")).toBe("#12abEF");
  });

  it("never writes a non-hex accent into CSS (style-injection guard)", () => {
    const { container } = render(
      <ProfileHero name="alice" accentColor="red;background:url(https://evil.test/x)" />
    );
    const el = banner(container);
    expect(el.classList.contains("mc-hero-accent")).toBe(false);
    expect(el.style.getPropertyValue("--mc-accent")).toBe("");
  });

  it("uses the default gradient with neither banner nor accent, and keeps the avatar ring", () => {
    const { container } = render(<ProfileHero name="alice" />);
    const el = banner(container);
    expect(el.tagName).toBe("DIV");
    expect(el.classList.contains("mc-hero-accent")).toBe(false);
    expect(container.querySelector(".mc-avatar-ring")).not.toBeNull();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("animate plays the GIF on an open card, but Reduce Motion falls back to the poster", () => {
    useAccessibilityStore.setState({ reduceMotion: false });
    const props = {
      name: "alice",
      avatarUrl: "https://cdn.test/poster.png",
      animatedUrl: "https://cdn.test/anim.gif",
      animate: true,
    };
    const { container, unmount } = render(<ProfileHero {...props} />);
    expect(container.querySelector(".mc-avatar-ring img")?.getAttribute("src")).toBe("https://cdn.test/anim.gif");
    unmount();

    useAccessibilityStore.setState({ reduceMotion: true });
    const second = render(<ProfileHero {...props} />);
    expect(second.container.querySelector(".mc-avatar-ring img")?.getAttribute("src")).toBe("https://cdn.test/poster.png");
    useAccessibilityStore.setState({ reduceMotion: false });
  });

  it("uses the animated banner only when animation is enabled and reduced motion is off", () => {
    const props = { name: "alice", bannerUrl: "https://cdn.test/banner.jpg", animatedBannerUrl: "https://cdn.test/banner.gif", animate: true };
    useAccessibilityStore.setState({ reduceMotion: false });
    const first = render(<ProfileHero {...props} />);
    expect(first.container.querySelector(".mc-hero-banner")?.getAttribute("src")).toBe("https://cdn.test/banner.gif");
    first.unmount();
    useAccessibilityStore.setState({ reduceMotion: true });
    const second = render(<ProfileHero {...props} />);
    expect(second.container.querySelector(".mc-hero-banner")?.getAttribute("src")).toBe("https://cdn.test/banner.jpg");
    useAccessibilityStore.setState({ reduceMotion: false });
  });
});
