/**
 * applyAccessibility — DOM-mutation regression tests.
 *
 * These cover the contract between accessibilityStore and globals.css:
 * every settable field must produce the exact CSS custom property or
 * body class that the stylesheet keys off of. Drifts here (e.g. a
 * setter writes `--font-size` but CSS reads `--chat-font-size`) ship
 * a "setting silently does nothing" bug. The tests pin both names.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  applyAccessibility,
  DEFAULT_ACCESSIBILITY,
  type AccessibilityState,
} from "./accessibility";

function freshState(overrides: Partial<AccessibilityState> = {}): AccessibilityState {
  return { ...DEFAULT_ACCESSIBILITY, ...overrides };
}

describe("applyAccessibility — CSS custom properties", () => {
  beforeEach(() => {
    // Reset the DOM mutations between tests. JSDom's documentElement
    // persists across tests, so clearing inline style is enough.
    document.documentElement.removeAttribute("style");
    document.body.className = "";
  });

  it("writes chat font size", () => {
    applyAccessibility(freshState({ chatFontSize: 22 }));
    expect(document.documentElement.style.getPropertyValue("--chat-font-size"))
      .toBe("22px");
  });

  it("link decoration toggles between 'underline' and 'none'", () => {
    applyAccessibility(freshState({ alwaysUnderlineLinks: true }));
    expect(document.documentElement.style.getPropertyValue("--link-decoration"))
      .toBe("underline");

    applyAccessibility(freshState({ alwaysUnderlineLinks: false }));
    expect(document.documentElement.style.getPropertyValue("--link-decoration"))
      .toBe("none");
  });

  it("density scale maps compact → 0.85, default → 1.0, cozy → 1.15", () => {
    applyAccessibility(freshState({ density: "compact" }));
    expect(document.documentElement.style.getPropertyValue("--density-scale")).toBe("0.85");
    applyAccessibility(freshState({ density: "default" }));
    expect(document.documentElement.style.getPropertyValue("--density-scale")).toBe("1.0");
    applyAccessibility(freshState({ density: "cozy" }));
    expect(document.documentElement.style.getPropertyValue("--density-scale")).toBe("1.15");
  });

  it("message group gap is written in px", () => {
    applyAccessibility(freshState({ messageGroupGapPx: 8 }));
    expect(document.documentElement.style.getPropertyValue("--msg-group-gap")).toBe("8px");
  });

  it("saturation is written as a percent suffix", () => {
    applyAccessibility(freshState({ saturation: 50 }));
    expect(document.documentElement.style.getPropertyValue("--saturation")).toBe("50%");
  });

  it("reduce motion collapses transition duration to 0ms", () => {
    applyAccessibility(freshState({ reduceMotion: true }));
    expect(document.documentElement.style.getPropertyValue("--motion-duration")).toBe("0ms");
    expect(document.documentElement.style.getPropertyValue("--motion-scale")).toBe("1");
  });

  it("reduce motion off restores the 200ms / 1.05 defaults", () => {
    applyAccessibility(freshState({ reduceMotion: false }));
    expect(document.documentElement.style.getPropertyValue("--motion-duration")).toBe("200ms");
    expect(document.documentElement.style.getPropertyValue("--motion-scale")).toBe("1.05");
  });
});

describe("applyAccessibility — body modifier classes", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
    document.body.className = "";
  });

  it("density-compact body class only present when density is compact", () => {
    applyAccessibility(freshState({ density: "compact" }));
    expect(document.body.classList.contains("density-compact")).toBe(true);
    expect(document.body.classList.contains("density-cozy")).toBe(false);

    applyAccessibility(freshState({ density: "default" }));
    expect(document.body.classList.contains("density-compact")).toBe(false);
    expect(document.body.classList.contains("density-cozy")).toBe(false);

    applyAccessibility(freshState({ density: "cozy" }));
    expect(document.body.classList.contains("density-compact")).toBe(false);
    expect(document.body.classList.contains("density-cozy")).toBe(true);
  });

  it("msg-style-compact mirrors messageStyle field", () => {
    applyAccessibility(freshState({ messageStyle: "compact" }));
    expect(document.body.classList.contains("msg-style-compact")).toBe(true);

    applyAccessibility(freshState({ messageStyle: "default" }));
    expect(document.body.classList.contains("msg-style-compact")).toBe(false);
  });

  it("saturate-custom class follows the toggle", () => {
    applyAccessibility(freshState({ saturateCustomColors: true }));
    expect(document.body.classList.contains("saturate-custom")).toBe(true);

    applyAccessibility(freshState({ saturateCustomColors: false }));
    expect(document.body.classList.contains("saturate-custom")).toBe(false);
  });

  it("reduce-motion body class matches reduceMotion field", () => {
    applyAccessibility(freshState({ reduceMotion: true }));
    expect(document.body.classList.contains("reduce-motion")).toBe(true);

    applyAccessibility(freshState({ reduceMotion: false }));
    expect(document.body.classList.contains("reduce-motion")).toBe(false);
  });

  it("display-name-plain is the inverse of showDisplayNameStyles", () => {
    applyAccessibility(freshState({ showDisplayNameStyles: false }));
    expect(document.body.classList.contains("display-name-plain")).toBe(true);

    applyAccessibility(freshState({ showDisplayNameStyles: true }));
    expect(document.body.classList.contains("display-name-plain")).toBe(false);
  });

  it("no-animated-emoji and no-gif-autoplay reflect their respective fields", () => {
    applyAccessibility(freshState({ disableAnimatedEmoji: true, autoplayGifs: false }));
    expect(document.body.classList.contains("no-animated-emoji")).toBe(true);
    expect(document.body.classList.contains("no-gif-autoplay")).toBe(true);

    applyAccessibility(freshState({ disableAnimatedEmoji: false, autoplayGifs: true }));
    expect(document.body.classList.contains("no-animated-emoji")).toBe(false);
    expect(document.body.classList.contains("no-gif-autoplay")).toBe(false);
  });
});
