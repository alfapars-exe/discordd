import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SyncState = { syncStatus: string; hasPendingChanges: boolean };
type SyncListener = (state: SyncState, previous: SyncState) => void;
const mocks = vi.hoisted(() => ({
  user: { id: "alice" } as { id: string } | null,
  state: { syncStatus: "saved", hasPendingChanges: false },
  listeners: new Set<SyncListener>(),
  fetch: vi.fn(), retry: vi.fn(), toast: vi.fn(),
  t: (key: string) => `translated:${key}`,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("../stores/authStore", () => ({
  useAuthStore: (selector: (state: { user: { id: string } | null }) => unknown) => selector({ user: mocks.user }),
}));
vi.mock("../stores/preferencesStore", () => ({
  usePreferencesStore: {
    getState: () => ({ ...mocks.state, fetchAndApply: mocks.fetch, retrySync: mocks.retry }),
    subscribe: (listener: SyncListener) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));
vi.mock("../stores/toastStore", () => ({ useToastStore: { getState: () => ({ addToast: mocks.toast }) } }));
import { usePreferencesSync } from "./usePreferencesSync";

function setStatus(syncStatus: string) {
  const previous = mocks.state;
  mocks.state = { ...previous, syncStatus };
  mocks.listeners.forEach((listener) => listener(mocks.state, previous));
}
function unload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("preference synchronization lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = { id: "alice" };
    mocks.state = { syncStatus: "saved", hasPendingChanges: false };
    mocks.listeners.clear();
    mocks.fetch.mockResolvedValue(undefined);
    mocks.retry.mockResolvedValue(undefined);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not install synchronization for a logged-out user", () => {
    mocks.user = null;
    renderHook(() => usePreferencesSync());
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    mocks.state.hasPendingChanges = true;
    expect(unload().defaultPrevented).toBe(false);
    expect(mocks.listeners.size).toBe(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it("retries pending work on reconnect and refreshes on visible focus only", () => {
    renderHook(() => usePreferencesSync());
    expect(mocks.fetch).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("online"));
    expect(mocks.retry).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    window.dispatchEvent(new Event("focus"));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  });

  it("warns before unload only while the latest state has unsaved edits", () => {
    renderHook(() => usePreferencesSync());
    expect(unload().defaultPrevented).toBe(false);
    mocks.state.hasPendingChanges = true;
    expect(unload().defaultPrevented).toBe(true);
    mocks.state.hasPendingChanges = false;
    expect(unload().defaultPrevented).toBe(false);
  });

  it("shows one warning when entering error, not on every error update", () => {
    renderHook(() => usePreferencesSync());
    setStatus("pending");
    setStatus("saving");
    expect(mocks.toast).not.toHaveBeenCalled();
    setStatus("error");
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith("warning", "translated:preferencesSync.error", 6000);
    setStatus("error");
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    setStatus("saving");
    setStatus("error");
    expect(mocks.toast).toHaveBeenCalledTimes(2);
  });

  it("removes every event listener and the store subscription on unmount", () => {
    const { unmount } = renderHook(() => usePreferencesSync());
    expect(mocks.listeners.size).toBe(1);
    unmount();
    mocks.state.hasPendingChanges = true;
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    expect(unload().defaultPrevented).toBe(false);
    setStatus("error");
    expect(mocks.listeners.size).toBe(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("replaces listeners when the account changes and removes them on logout", () => {
    const { rerender } = renderHook(() => usePreferencesSync());
    const firstListener = [...mocks.listeners][0];
    mocks.user = { id: "bob" };
    rerender();
    expect(mocks.listeners.size).toBe(1);
    expect(mocks.listeners.has(firstListener)).toBe(false);
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    expect(mocks.retry).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    mocks.user = null;
    rerender();
    expect(mocks.listeners.size).toBe(0);
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    mocks.state.hasPendingChanges = true;
    expect(unload().defaultPrevented).toBe(false);
    expect(mocks.retry).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
