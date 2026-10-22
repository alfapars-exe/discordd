/**
 * Avatar — animated (GIF) avatar playback rules.
 *
 * The static poster (`avatarUrl`) is the default src; the animated file is
 * swapped in on hover, when the parent says `animate`, or in "always" mode
 * unless Reduce Motion is on (hover still plays — it is a user action).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Avatar from "./Avatar";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAccessibilityStore } from "../../stores/accessibilityStore";

const POSTER = "https://cdn.test/poster.png";
const ANIM = "https://cdn.test/anim.gif";

function img(): HTMLImageElement {
  return screen.getByAltText("alice") as HTMLImageElement;
}

describe("Avatar — animated avatars", () => {
  beforeEach(() => {
    useSettingsStore.setState({ avatarAnimation: "hover" });
    useAccessibilityStore.setState({ reduceMotion: false });
  });

  it("shows the static poster by default and the GIF while hovered", () => {
    render(<Avatar name="alice" avatarUrl={POSTER} animatedUrl={ANIM} hasAdjacentLabel={false} />);
    expect(img().src).toBe(POSTER);
    fireEvent.mouseEnter(img());
    expect(img().src).toBe(ANIM);
    fireEvent.mouseLeave(img());
    expect(img().src).toBe(POSTER);
  });

  it("plays when the parent passes animate", () => {
    render(<Avatar name="alice" avatarUrl={POSTER} animatedUrl={ANIM} animate hasAdjacentLabel={false} />);
    expect(img().src).toBe(ANIM);
  });

  it("autoplays in 'always' mode", () => {
    useSettingsStore.setState({ avatarAnimation: "always" });
    render(<Avatar name="alice" avatarUrl={POSTER} animatedUrl={ANIM} hasAdjacentLabel={false} />);
    expect(img().src).toBe(ANIM);
  });

  it("ignores 'always' under Reduce Motion, but hover still plays", () => {
    useSettingsStore.setState({ avatarAnimation: "always" });
    useAccessibilityStore.setState({ reduceMotion: true });
    render(<Avatar name="alice" avatarUrl={POSTER} animatedUrl={ANIM} hasAdjacentLabel={false} />);
    expect(img().src).toBe(POSTER);
    fireEvent.mouseEnter(img());
    expect(img().src).toBe(ANIM);
  });

  it("behaves exactly as before without animatedUrl", () => {
    useSettingsStore.setState({ avatarAnimation: "always" });
    render(<Avatar name="alice" avatarUrl={POSTER} animate hasAdjacentLabel={false} />);
    expect(img().src).toBe(POSTER);
    fireEvent.mouseEnter(img());
    expect(img().src).toBe(POSTER);
  });

  it("renders the initial fallback when there is no avatar", () => {
    render(<Avatar name="bob" animatedUrl={ANIM} />);
    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
