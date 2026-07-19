/**
 * LandingPage — missing-asset behaviour.
 *
 * The demo video and the four showcase screenshots live under
 * /static/landing and are uploaded per deployment rather than committed.
 * Production currently 404s all five, so the marketing page — the first
 * thing any visitor sees — rendered broken-image glyphs and an empty video
 * frame. These tests pin that a 404 removes the element and leaves the copy
 * intact, and that a working asset is still rendered.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import LandingPage from "./LandingPage";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "tr" },
  }),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../../i18n", () => ({
  changeLanguage: vi.fn(),
}));

vi.mock("../../api/stats", () => ({
  getPublicStats: vi.fn().mockResolvedValue({ success: true, data: { total_users: 42 } }),
}));

vi.mock("../../utils/detectOS", () => ({
  detectOS: () => ({ os: "windows", url: "https://example.test/setup.exe", i18nKey: "download" }),
}));

// RevealOnScroll wraps children in an IntersectionObserver; render children
// directly so the assertions don't depend on scroll simulation.
vi.mock("./RevealOnScroll", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("./SmartScreenGuide", () => ({ default: () => null }));

vi.mock("./landingData", () => ({
  FEATURES: [],
  COMPARISON_ROWS: [],
}));

vi.mock("../../styles/landing.css", () => ({}));

beforeEach(() => {
  vi.clearAllMocks();
});

/** Screenshots are <img>; the demo clip is <video>. */
function showcaseImages(container: HTMLElement) {
  return Array.from(container.querySelectorAll("img.lp-showcase-img"));
}
function demoVideo(container: HTMLElement) {
  return container.querySelector("video.lp-hero-video");
}

describe("LandingPage missing assets", () => {
  it("renders the video and all four screenshots when the assets load", () => {
    const { container } = render(<LandingPage />);
    expect(demoVideo(container)).not.toBeNull();
    expect(showcaseImages(container)).toHaveLength(4);
  });

  it("drops a screenshot that 404s but keeps its copy", () => {
    const { container } = render(<LandingPage />);
    const images = showcaseImages(container);
    expect(images).toHaveLength(4);

    // The section headings are rendered from the same SHOWCASE entries, so
    // they are what proves the row survived without its image.
    expect(screen.getByText("sc1_title")).toBeInTheDocument();

    fireEvent.error(images[0]);

    expect(showcaseImages(container)).toHaveLength(3);
    expect(screen.getByText("sc1_title")).toBeInTheDocument();
    expect(screen.getByText("sc1_desc")).toBeInTheDocument();
  });

  it("removes the whole video block when the clip 404s", () => {
    const { container } = render(<LandingPage />);
    const video = demoVideo(container);
    expect(video).not.toBeNull();

    fireEvent.error(video!);

    // The wrapper goes too — an empty framed box reads as a broken player.
    expect(demoVideo(container)).toBeNull();
    expect(container.querySelector(".lp-hero-video-wrap")).toBeNull();
  });

  it("drops every screenshot independently when all of them 404", () => {
    // The current production state: none of the five assets are deployed.
    const { container } = render(<LandingPage />);
    for (const img of showcaseImages(container)) {
      fireEvent.error(img);
    }
    fireEvent.error(demoVideo(container)!);

    expect(showcaseImages(container)).toHaveLength(0);
    expect(demoVideo(container)).toBeNull();
    // All four rows still present as text.
    for (const key of ["sc1", "sc2", "sc3", "sc4"]) {
      expect(screen.getByText(`${key}_title`)).toBeInTheDocument();
    }
  });
});
