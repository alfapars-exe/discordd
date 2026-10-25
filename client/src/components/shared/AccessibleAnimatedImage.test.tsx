import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import AccessibleAnimatedImage from "./AccessibleAnimatedImage";

const preferences = vi.hoisted(() => ({ autoplayGifs: false, showImageDescriptions: false }));
vi.mock("../../stores/accessibilityStore", () => ({ useAccessibilityStore: (select: (value: typeof preferences) => unknown) => select(preferences) }));

it("does not carry deliberate playback into a different image or a changed autoplay policy", () => {
  const view = render(<AccessibleAnimatedImage src="/first.gif" alt="Preview" animated />);
  const image = view.container.querySelector("img")!;
  expect(image).toHaveAttribute("aria-hidden", "true");
  fireEvent.mouseEnter(view.container.querySelector("span")!);
  expect(screen.getByAltText("Preview")).not.toHaveAttribute("aria-hidden");
  view.rerender(<AccessibleAnimatedImage src="/second.gif" alt="Preview" animated />);
  expect(view.container.querySelector("img")).toHaveAttribute("aria-hidden", "true");
  preferences.autoplayGifs = true;
  view.rerender(<AccessibleAnimatedImage src="/second.gif" alt="Preview" animated />);
  expect(screen.getByAltText("Preview")).not.toHaveAttribute("aria-hidden");
  preferences.autoplayGifs = false;
  view.rerender(<AccessibleAnimatedImage src="/second.gif" alt="Preview" animated />);
  expect(view.container.querySelector("img")).toHaveAttribute("aria-hidden", "true");
});
