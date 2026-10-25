import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCESSIBILITY } from "../styles/accessibility";

const mocks = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("./preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ set: mocks.sync }) },
}));

const STORAGE_KEY = "tayfa.accessibility.v1";
async function freshStore(raw?: string) {
  if (raw !== undefined) localStorage.setItem(STORAGE_KEY, raw);
  return import("./accessibilityStore");
}
function fields(state: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(DEFAULT_ACCESSIBILITY).map((key) => [key, state[key]]));
}

describe("accessibility preference validation and hydration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
  });
  afterEach(() => {
    document.documentElement.removeAttribute("style");
    document.body.className = "";
  });

  it.each(["{broken", "null", "[]", '"invalid"', "42"])("ignores invalid persisted container %s", async (raw) => {
    const { useAccessibilityStore } = await freshStore(raw);
    expect(fields(useAccessibilityStore.getState())).toEqual(DEFAULT_ACCESSIBILITY);
    expect(document.documentElement.style.getPropertyValue("--chat-font-size")).toBe("16px");
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("loads only valid persisted fields without replacing methods", async () => {
    const { useAccessibilityStore } = await freshStore(JSON.stringify({
      chatFontSize: 20, density: "compact", reduceMotion: true,
      saturation: 101, messageGroupGapPx: -1, notificationSoundVolume: "80",
      alwaysUnderlineLinks: "false", messageStyle: "spacious", ttsEnabled: null,
      applyFromServer: "corrupt", resetAccountPreferences: false, setDensity: 123,
      constructor: { injected: true }, unknown: "legacy",
    }));
    const state = useAccessibilityStore.getState();
    expect(fields(state)).toEqual({ ...DEFAULT_ACCESSIBILITY, chatFontSize: 20, density: "compact", reduceMotion: true });
    expect(state.applyFromServer).toBeTypeOf("function");
    expect(state.resetAccountPreferences).toBeTypeOf("function");
    expect(state.setDensity).toBeTypeOf("function");
    expect(state).not.toHaveProperty("unknown");
    expect(Object.hasOwn(state, "constructor")).toBe(false);
    expect(document.body.classList.contains("density-compact")).toBe(true);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("accepts every existing preference with correct types and boundary values", async () => {
    const { sanitizeAccessibilityPreferences } = await freshStore();
    const valid = {
      chatFontSize: 12, alwaysUnderlineLinks: true, showDisplayNameStyles: false,
      density: "cozy", messageStyle: "compact", messageGroupGapPx: 24,
      saturation: 0, saturateCustomColors: true, reduceMotion: true,
      disableAnimatedEmoji: true, autoplayGifs: false, notificationSoundVolume: 100, ttsEnabled: true,
    };
    expect(sanitizeAccessibilityPreferences(valid)).toEqual(valid);
    expect(sanitizeAccessibilityPreferences({ chatFontSize: 24, messageGroupGapPx: 0, saturation: 100, notificationSoundVolume: 0 }))
      .toEqual({ chatFontSize: 24, messageGroupGapPx: 0, saturation: 100, notificationSoundVolume: 0 });
  });

  it("rejects non-finite, out-of-range, inherited, and unknown fields", async () => {
    const { sanitizeAccessibilityPreferences } = await freshStore();
    expect(sanitizeAccessibilityPreferences({
      chatFontSize: Number.NaN, messageGroupGapPx: Number.POSITIVE_INFINITY,
      saturation: -1, notificationSoundVolume: 101, density: "wide",
      messageStyle: "cozy", ttsEnabled: 1, autoplayGifs: "true", reset: "lost",
    })).toEqual({});
    expect(sanitizeAccessibilityPreferences(Object.create({ reduceMotion: true }))).toEqual({});
  });

  it("merges server leaves, ignores corrupt values, and never echoes hydration", async () => {
    const { useAccessibilityStore } = await freshStore(JSON.stringify({ chatFontSize: 18, density: "cozy" }));
    const original = useAccessibilityStore.getState();
    original.applyFromServer({
      reduceMotion: true, saturation: 50, chatFontSize: 200,
      applyFromServer: "lost", resetAccountPreferences: false, extra: true,
    });
    const state = useAccessibilityStore.getState();
    expect(fields(state)).toEqual({ ...DEFAULT_ACCESSIBILITY, chatFontSize: 18, density: "cozy", reduceMotion: true, saturation: 50 });
    expect(state.applyFromServer).toBe(original.applyFromServer);
    expect(state.resetAccountPreferences).toBe(original.resetAccountPreferences);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(fields(state));
    expect(document.documentElement.style.getPropertyValue("--saturation")).toBe("50%");
    expect(document.body.classList.contains("reduce-motion")).toBe(true);
    expect(mocks.sync).not.toHaveBeenCalled();
    for (const invalid of [null, [], "bad", 0]) state.applyFromServer(invalid);
    expect(fields(useAccessibilityStore.getState())).toEqual(fields(state));
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("syncs only the edited leaf while keeping the complete safe local cache", async () => {
    const { useAccessibilityStore } = await freshStore();
    useAccessibilityStore.getState().applyFromServer({ density: "cozy", saturation: 25 });
    useAccessibilityStore.getState().setChatFontSize(20);
    useAccessibilityStore.getState().setReduceMotion(true);
    useAccessibilityStore.getState().setDensity("compact");
    expect(mocks.sync.mock.calls.map(([patch]) => patch)).toEqual([
      { accessibility: { chatFontSize: 20 } },
      { accessibility: { reduceMotion: true } },
      { accessibility: { density: "compact" } },
    ]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      ...DEFAULT_ACCESSIBILITY, chatFontSize: 20, density: "compact", saturation: 25, reduceMotion: true,
    });
  });

  it("resets the old account to defaults without sending a preference write", async () => {
    const { useAccessibilityStore } = await freshStore();
    useAccessibilityStore.getState().applyFromServer({ chatFontSize: 24, reduceMotion: true, ttsEnabled: true });
    useAccessibilityStore.getState().resetAccountPreferences();
    expect(fields(useAccessibilityStore.getState())).toEqual(DEFAULT_ACCESSIBILITY);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(DEFAULT_ACCESSIBILITY);
    expect(document.body.classList.contains("reduce-motion")).toBe(false);
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("retains the explicit user reset and numeric setter clamping behavior", async () => {
    const { useAccessibilityStore } = await freshStore();
    useAccessibilityStore.getState().setChatFontSize(100);
    expect(useAccessibilityStore.getState().chatFontSize).toBe(24);
    useAccessibilityStore.getState().setSaturation(-10);
    expect(useAccessibilityStore.getState().saturation).toBe(0);
    useAccessibilityStore.getState().reset();
    expect(fields(useAccessibilityStore.getState())).toEqual(DEFAULT_ACCESSIBILITY);
    expect(mocks.sync).toHaveBeenLastCalledWith({ accessibility: DEFAULT_ACCESSIBILITY });
  });
});
