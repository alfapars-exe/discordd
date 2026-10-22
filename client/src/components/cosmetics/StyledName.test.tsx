import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import StyledName from "./StyledName";
import { useSettingsStore } from "../../stores/settingsStore";
import type { EquippedCosmetic } from "../../types/cosmetics";

const initialTheme = useSettingsStore.getState().themeId;

const gold: EquippedCosmetic = {
  item_id: "b_name_gold",
  format: "css",
  animated: false,
  asset: { v: 1, font: "bold", stops: ["#ffd166", "#ffb703"], angle: 90 },
};

afterEach(() => {
  useSettingsStore.setState({ themeId: initialTheme });
});

describe("StyledName", () => {
  it("applies a readable style on a dark theme (midnight)", () => {
    useSettingsStore.setState({ themeId: "midnight" });
    render(<StyledName name="alice" style={gold} fallbackColor="#ff0000" />);
    const el = screen.getByTestId("cos-name");
    expect(el).toHaveTextContent("alice");
    expect(el.className).toContain("cos-font-bold");
    expect(el.className).toContain("cos-name--gradient");
    expect(el.style.getPropertyValue("--cos-ns-a")).toBe("#ffd166");
    expect(el.style.getPropertyValue("--cos-ns-angle")).toBe("90deg");
  });

  it("falls back on the light theme (crispLight) where contrast fails", () => {
    useSettingsStore.setState({ themeId: "crispLight" });
    render(<StyledName name="alice" style={gold} fallbackColor="#ff0000" />);
    expect(screen.queryByTestId("cos-name")).toBeNull();
    const el = screen.getByText("alice");
    expect(el.style.color).toBe("rgb(255, 0, 0)");
  });

  it("falls back for an invalid asset", () => {
    useSettingsStore.setState({ themeId: "midnight" });
    const bad: EquippedCosmetic = {
      ...gold,
      asset: { v: 1, font: "comic", stops: ["#ffffff"], angle: 0 },
    };
    render(<StyledName name="alice" style={bad} />);
    expect(screen.queryByTestId("cos-name")).toBeNull();
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("renders the name as a text node, never markup", () => {
    useSettingsStore.setState({ themeId: "midnight" });
    const { container } = render(<StyledName name="<b>x</b>" style={gold} />);
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("<b>x</b>")).toBeInTheDocument();
  });
});
