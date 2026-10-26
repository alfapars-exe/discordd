import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReducedMotion } from "./useReducedMotion";

const prefs = vi.hoisted(() => ({ reduceMotion: false, syncReducedMotion: true }));
vi.mock("../stores/accessibilityStore", () => ({
  useAccessibilityStore: (selector: (state: typeof prefs) => unknown) => selector(prefs),
}));

let matches = false;
let listeners: Set<() => void>;

beforeEach(() => {
  prefs.reduceMotion = false;
  prefs.syncReducedMotion = true;
  matches = false;
  listeners = new Set();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return matches; },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function changeOsMotion(value: boolean) {
  act(() => {
    matches = value;
    listeners.forEach(listener => listener());
  });
}

describe("useReducedMotion", () => {
  it("updates mounted media consumers on live OS changes and removes its listener", () => {
    const { result, unmount } = renderHook(useReducedMotion);
    expect(result.current).toBe(false);
    changeOsMotion(true);
    expect(result.current).toBe(true);
    changeOsMotion(false);
    expect(result.current).toBe(false);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it("keeps the account sync opt-out and explicit reduced motion authoritative", () => {
    prefs.syncReducedMotion = false;
    const { result, rerender } = renderHook(useReducedMotion);
    changeOsMotion(true);
    expect(result.current).toBe(false);
    prefs.reduceMotion = true;
    rerender();
    expect(result.current).toBe(true);
    changeOsMotion(false);
    expect(result.current).toBe(true);
  });

  it("works when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { result } = renderHook(useReducedMotion);
    expect(result.current).toBe(false);
  });
});
