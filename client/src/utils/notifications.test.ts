import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeAuthState = { user: { id: string } | null; manualStatus: string };
type FakePreferencesState = { accountId: string | null; data: Record<string, unknown> };
const h = vi.hoisted(() => ({
  auth: { user: { id: "alice" }, manualStatus: "online" } as FakeAuthState,
  prefs: { accountId: "alice", data: { notifications: { desktopEnabled: true, notifyWhenFocused: false, desktopDelaySeconds: 3 } } } as FakePreferencesState,
  authListeners: new Set<(state: FakeAuthState, previous: FakeAuthState) => void>(),
  prefsListeners: new Set<(state: FakePreferencesState, previous: FakePreferencesState) => void>(),
  generation: 1,
  emitted: [] as Array<{ title: string; options?: NotificationOptions }>,
}));
vi.mock("../api/client", () => ({ getAuthGeneration: () => h.generation }));
vi.mock("../stores/authStore", () => ({ useAuthStore: {
  getState: () => h.auth,
  subscribe: (listener: (state: FakeAuthState, previous: FakeAuthState) => void) => { h.authListeners.add(listener); return () => h.authListeners.delete(listener); },
} }));
vi.mock("../stores/preferencesStore", () => ({ usePreferencesStore: {
  getState: () => h.prefs,
  subscribe: (listener: (state: FakePreferencesState, previous: FakePreferencesState) => void) => { h.prefsListeners.add(listener); return () => h.prefsListeners.delete(listener); },
} }));

import { cancelPendingDesktopNotifications, showNotification } from "./notifications";

class FakeNotification {
  static permission: NotificationPermission = "granted";
  onclick: ((event: Event) => void) | null = null;
  title: string;
  options?: NotificationOptions;
  constructor(title: string, options?: NotificationOptions) { this.title = title; this.options = options; h.emitted.push({ title, options }); }
  close() {}
}

function updateAuth(next: Partial<FakeAuthState>) {
  const previous = { ...h.auth } as FakeAuthState;
  Object.assign(h.auth, next);
  for (const listener of [...h.authListeners]) listener(h.auth, previous);
}
describe("desktop notification delay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.auth.user = { id: "alice" };
    h.auth.manualStatus = "online";
    h.prefs.accountId = "alice";
    h.prefs.data = { notifications: { desktopEnabled: true, notifyWhenFocused: false, desktopDelaySeconds: 3 } };
    h.generation = 1;
    h.emitted.length = 0;
    h.authListeners.clear();
    h.prefsListeners.clear();
    FakeNotification.permission = "granted";
    vi.stubGlobal("Notification", FakeNotification);
    Object.defineProperty(window, "Notification", { configurable: true, value: FakeNotification });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
  });
  afterEach(() => {
    cancelPendingDesktopNotifications();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("delivers immediately when delay is zero", () => {
    h.prefs.data = { notifications: { desktopEnabled: true, notifyWhenFocused: false, desktopDelaySeconds: 0 } };
    showNotification({ title: "Now" });
    expect(h.emitted.map((item) => item.title)).toEqual(["Now"]);
  });

  it("coalesces equal tags and delivers the newest content at the selected delay", () => {
    showNotification({ title: "Old", body: "first", tag: "dm:1" });
    vi.advanceTimersByTime(2000);
    showNotification({ title: "New", body: "latest", tag: "dm:1" });
    vi.advanceTimersByTime(2999);
    expect(h.emitted).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.emitted).toEqual([{ title: "New", options: expect.objectContaining({ body: "latest", tag: "dm:1" }) }]);
  });

  it("rechecks source eligibility and current foreground state at delivery", () => {
    let eligible = true;
    showNotification({ title: "Read later", isStillEligible: () => eligible });
    eligible = false;
    vi.advanceTimersByTime(3000);
    expect(h.emitted).toHaveLength(0);

    showNotification({ title: "Focused later" });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.advanceTimersByTime(3000);
    expect(h.emitted).toHaveLength(0);
  });

  it("cancels queued delivery on logout, account/generation change, or desktop disable", () => {
    showNotification({ title: "Logout" });
    updateAuth({ user: null });
    vi.advanceTimersByTime(3000);
    expect(h.emitted).toHaveLength(0);

    updateAuth({ user: { id: "alice" } });
    showNotification({ title: "Reauth" });
    h.generation++;
    updateAuth({ manualStatus: "idle" });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3000);
    expect(h.emitted).toHaveLength(0);

    h.generation++;
    showNotification({ title: "Disable" });
    const previous = { ...h.prefs };
    h.prefs.data = { notifications: { desktopEnabled: true, notifyWhenFocused: false, desktopDelaySeconds: 3 } };
    h.prefs.accountId = "bob";
    for (const listener of [...h.prefsListeners]) listener(h.prefs, previous);
    vi.advanceTimersByTime(3000);
    expect(h.emitted).toHaveLength(0);

    h.prefs.accountId = "alice";
    showNotification({ title: "Disable" });
    const beforeDisable = { ...h.prefs };
    h.prefs.data = { notifications: { desktopEnabled: false, notifyWhenFocused: false, desktopDelaySeconds: 3 } };
    for (const listener of [...h.prefsListeners]) listener(h.prefs, beforeDisable);
    vi.advanceTimersByTime(3000);
    expect(h.emitted).toHaveLength(0);
  });

  it("suppresses delivery if DND or OS permission changes before the timer expires", () => {
    showNotification({ title: "DND" });
    updateAuth({ manualStatus: "dnd" });
    vi.advanceTimersByTime(3000);
    expect(h.emitted).toHaveLength(0);

    updateAuth({ manualStatus: "online" });
    showNotification({ title: "Permission" });
    FakeNotification.permission = "denied";
    vi.advanceTimersByTime(3000);
    expect(h.emitted).toHaveLength(0);
  });
});
