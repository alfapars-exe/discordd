import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "./settingsStore";

/**
 * UI Scale (Appearance → Uygulama Ölçeği). The store keeps an integer percent
 * (100–200, default 100) and applies it as the --ui-scale CSS custom property
 * (a unitless zoom factor) on :root, mirroring the neon/lightning pattern.
 * globals.css turns that var into `html { zoom: var(--ui-scale) }`.
 */
describe("settingsStore — uiScale (UI Scale)", () => {
  beforeEach(() => {
    useSettingsStore.getState().setUiScale(100);
  });

  it("persists, clamps to 100–200, and writes --ui-scale as a zoom factor", () => {
    const { setUiScale } = useSettingsStore.getState();

    setUiScale(130);
    expect(useSettingsStore.getState().uiScale).toBe(130);
    expect(localStorage.getItem("mqvi_ui_scale")).toBe("130");
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("1.3");

    // Clamp below the floor.
    setUiScale(40);
    expect(useSettingsStore.getState().uiScale).toBe(100);
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("1");

    // Clamp above the ceiling.
    setUiScale(900);
    expect(useSettingsStore.getState().uiScale).toBe(200);
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("2");

    // Non-integer input is rounded.
    setUiScale(133.7);
    expect(useSettingsStore.getState().uiScale).toBe(134);
  });
});
