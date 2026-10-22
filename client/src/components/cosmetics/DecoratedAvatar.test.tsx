import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import DecoratedAvatar from "./DecoratedAvatar";
import { useAccessibilityStore } from "../../stores/accessibilityStore";
import type { EquippedCosmetic } from "../../types/cosmetics";

const svgFrame = (frame: string, animated = true): EquippedCosmetic => ({
  item_id: `b_frame_${frame}`,
  format: "svg",
  animated,
  asset: { v: 1, frame },
});

const raster = (url: string, animated_url?: string): EquippedCosmetic => ({
  item_id: "0123456789abcdef",
  format: "raster",
  animated: !!animated_url,
  asset: animated_url ? { v: 1, url, animated_url } : { v: 1, url },
});

const GOOD_PNG = "/api/uploads/cosmetics/0123456789abcdef.png";
const GOOD_GIF = "/api/uploads/cosmetics/0123456789abcdef.gif";

beforeEach(() => {
  useAccessibilityStore.setState({ reduceMotion: false });
});

describe("DecoratedAvatar", () => {
  it("renders a plain avatar without a frame", () => {
    render(<DecoratedAvatar name="alice" size={30} />);
    expect(screen.queryByTestId("cos-frame")).toBeNull();
  });

  it("renders a built-in SVG frame, decorative and click-through", () => {
    const { container } = render(<DecoratedAvatar name="alice" size={40} frame={svgFrame("aurora")} />);
    const frame = screen.getByTestId("cos-frame");
    expect(frame).toHaveAttribute("aria-hidden", "true");
    expect(frame.style.width).toBe("50px"); // 40 × 1.25
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("foreignObject, image, use")).toBeNull();
  });

  it("drops an invalid asset (no frame)", () => {
    render(<DecoratedAvatar name="alice" frame={svgFrame("evil")} />);
    expect(screen.queryByTestId("cos-frame")).toBeNull();
    render(
      <DecoratedAvatar
        name="bob"
        frame={{ item_id: "x", format: "svg", animated: false, asset: { v: 1, frame: "aurora", css: "x" } }}
      />,
    );
    expect(screen.queryByTestId("cos-frame")).toBeNull();
  });

  it("never renders <img> for a bad raster URL", () => {
    const { container, rerender } = render(<DecoratedAvatar name="alice" frame={raster("https://evil/x.png")} />);
    expect(container.querySelector(".cos-frame-img")).toBeNull();
    rerender(<DecoratedAvatar name="alice" frame={raster("/api/uploads/cosmetics/../a.png")} />);
    expect(container.querySelector(".cos-frame-img")).toBeNull();
  });

  it("renders a valid raster frame, animated file only while animating", () => {
    const { container, rerender } = render(
      <DecoratedAvatar name="alice" frame={raster(GOOD_PNG, GOOD_GIF)} animateFrame={false} />,
    );
    const img = container.querySelector(".cos-frame-img") as HTMLImageElement;
    expect(img.getAttribute("src")).toContain(GOOD_PNG);
    rerender(<DecoratedAvatar name="alice" frame={raster(GOOD_PNG, GOOD_GIF)} animateFrame />);
    expect((container.querySelector(".cos-frame-img") as HTMLImageElement).getAttribute("src")).toContain(GOOD_GIF);
  });

  it("animates only when asked and motion is allowed", () => {
    const { rerender } = render(<DecoratedAvatar name="alice" frame={svgFrame("aurora")} animateFrame />);
    expect(screen.getByTestId("cos-frame").className).toContain("cos-frame--animate");

    rerender(<DecoratedAvatar name="alice" frame={svgFrame("aurora")} animateFrame={false} />);
    expect(screen.getByTestId("cos-frame").className).not.toContain("cos-frame--animate");

    useAccessibilityStore.setState({ reduceMotion: true });
    rerender(<DecoratedAvatar name="alice" frame={svgFrame("aurora")} animateFrame />);
    const cls = screen.getByTestId("cos-frame").className;
    expect(cls).not.toContain("cos-frame--animate");
    expect(cls).not.toContain("cos-frame--hoverable");
  });

  it("uses the animated GIF never under reduced motion", () => {
    useAccessibilityStore.setState({ reduceMotion: true });
    const { container } = render(<DecoratedAvatar name="alice" frame={raster(GOOD_PNG, GOOD_GIF)} animateFrame />);
    expect((container.querySelector(".cos-frame-img") as HTMLImageElement).getAttribute("src")).toContain(GOOD_PNG);
  });
});
