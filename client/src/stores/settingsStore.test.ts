import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSettingsStore, scaleFromPosition } from "./settingsStore";

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

/**
 * scaleFromPosition is the pure core of the LIVE UI-scale slider. The slider
 * sits inside the zoomed UI, so the drag handler feeds it a "virtual position"
 * advanced by PHYSICAL pointer deltas (PointerEvent.movementX) — which do NOT
 * feed back through the zoomed track's reflow — instead of re-reading the
 * native input's value. This function maps that position (px from the track's
 * left edge) to a clamped, step-rounded percentage.
 */
describe("scaleFromPosition (UI-scale slider drag mapping)", () => {
  it("maps a track-relative position to a clamped, step-10 percentage", () => {
    expect(scaleFromPosition(0, 200)).toBe(100); // left edge → min
    expect(scaleFromPosition(200, 200)).toBe(200); // right edge → max
    expect(scaleFromPosition(100, 200)).toBe(150); // midpoint
    expect(scaleFromPosition(40, 200)).toBe(120); // 20% → 120
    expect(scaleFromPosition(52, 200)).toBe(130); // 26% → rounds up to 130
  });

  it("clamps positions outside the track", () => {
    expect(scaleFromPosition(-50, 200)).toBe(100);
    expect(scaleFromPosition(9999, 200)).toBe(200);
  });

  it("guards against a zero or negative track width (no NaN/Infinity)", () => {
    expect(scaleFromPosition(50, 0)).toBe(100);
    expect(scaleFromPosition(50, -10)).toBe(100);
  });

  it("is monotonic non-decreasing in position (no oscillation)", () => {
    let prev = -Infinity;
    for (let p = -20; p <= 220; p += 5) {
      const v = scaleFromPosition(p, 200);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

/**
 * Background blur default flip (2026-08-13, product decision): blur used to
 * default ON (hardware-heuristic). It now defaults OFF for everyone,
 * including clients that already had "1" persisted from the old default —
 * we can't tell an explicit opt-in from the old auto-on default, so this is
 * a deliberate one-time reset gated by a migration marker key. Each test
 * re-imports the module fresh (vi.resetModules) to replay module-load-time
 * migration logic, mirroring the pattern in e2eeStore.test.ts.
 */
describe("settingsStore — blur default migration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("forces blurEnabled off on first load even if '1' was already persisted, and marks the migration done", async () => {
    localStorage.setItem("mqvi_blur_enabled", "1");

    vi.resetModules();
    const fresh = await import("./settingsStore");

    expect(fresh.useSettingsStore.getState().blurEnabled).toBe(false);
    expect(localStorage.getItem("mqvi_blur_enabled")).toBe("0");
    expect(localStorage.getItem("mqvi_blur_default_migrated_v1")).toBe("1");
  });

  it("defaults to false for a brand-new client with nothing persisted", async () => {
    vi.resetModules();
    const fresh = await import("./settingsStore");

    expect(fresh.useSettingsStore.getState().blurEnabled).toBe(false);
  });

  it("respects an explicit re-enable made after the one-time migration already ran", async () => {
    localStorage.setItem("mqvi_blur_default_migrated_v1", "1");
    localStorage.setItem("mqvi_blur_enabled", "1");

    vi.resetModules();
    const fresh = await import("./settingsStore");

    expect(fresh.useSettingsStore.getState().blurEnabled).toBe(true);
  });
});

/**
 * Blur strength (Appearance → Background blur, 8-40px, default 20, step 2).
 * Mirrors the lightningBlur/neonIntensity setter tests above — persists to
 * localStorage and clamps to range.
 */
describe("settingsStore — blurStrength", () => {
  beforeEach(() => {
    useSettingsStore.getState().setBlurStrength(20);
  });

  it("defaults to 20px", () => {
    expect(useSettingsStore.getState().blurStrength).toBe(20);
  });

  it("persists and clamps to the 8-40 range", () => {
    const { setBlurStrength } = useSettingsStore.getState();

    setBlurStrength(30);
    expect(useSettingsStore.getState().blurStrength).toBe(30);
    expect(localStorage.getItem("mqvi_blur_strength")).toBe("30");

    setBlurStrength(2);
    expect(useSettingsStore.getState().blurStrength).toBe(8);

    setBlurStrength(999);
    expect(useSettingsStore.getState().blurStrength).toBe(40);
  });
});
