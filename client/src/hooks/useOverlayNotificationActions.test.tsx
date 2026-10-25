import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  owner: "owner-1" as string | null,
  generation: 4,
  overlayEnabled: true, compatibility:false,
  notificationConsent: true,
  notificationActionsConsent: true,
  clickableConsent: true,
  liveItems: [{ id: "unread-1", category: "mention" }],
  receive: undefined as ((value: { session: string }) => void) | undefined,
  unsubscribe: vi.fn(),
  confirm: vi.fn<(...args: string[]) => Promise<unknown>>(),
  navigate: vi.fn(),
}));

vi.mock("../api/client", () => ({ getAuthGeneration: () => mocks.generation }));
vi.mock("../stores/authStore", () => ({
  useAuthStore: Object.assign((pick: (state: unknown) => unknown) => pick({ user: mocks.owner ? { id: mocks.owner } : null }), {
    getState: () => ({ user: mocks.owner ? { id: mocks.owner } : null }),
  }),
}));
vi.mock("../stores/voiceStore", () => ({
  useVoiceStore: Object.assign((pick: (state: unknown) => unknown) => pick({
    voiceOverlayCompatibility:mocks.compatibility, voiceOverlayEnabled: mocks.overlayEnabled,
    voiceOverlayNotifications: mocks.notificationConsent,
    voiceOverlayNotificationActions: mocks.notificationActionsConsent,
    voiceOverlayClickableActions: mocks.clickableConsent,
  }), {
    getState: () => ({
      voiceOverlayCompatibility:mocks.compatibility, voiceOverlayEnabled: mocks.overlayEnabled,
      voiceOverlayNotifications: mocks.notificationConsent,
      voiceOverlayNotificationActions: mocks.notificationActionsConsent,
      voiceOverlayClickableActions: mocks.clickableConsent,
    }),
  }),
}));
vi.mock("../stores/uiStore", () => ({ useUIStore: { getState: () => ({ navigate: mocks.navigate }) } }));
vi.mock("../utils/overlayNotificationAccess", () => ({ getLiveOverlayNotificationItems: () => mocks.liveItems }));
vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));

import { useOverlayNotificationActions } from "./useOverlayNotificationActions";

function installBridge() {
  const onOverlayOpenInbox = vi.fn((callback: (value: { session: string }) => void) => {
    mocks.receive = callback;
    return mocks.unsubscribe;
  });
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: { onOverlayOpenInbox, confirmOverlayOpenInbox: mocks.confirm },
  });
  return onOverlayOpenInbox;
}

function emit(session: string) {
  mocks.receive?.({ session });
}

beforeEach(() => {
  mocks.owner = "owner-1";
  mocks.generation = 4;
  mocks.overlayEnabled = true; mocks.compatibility=false;
  mocks.notificationConsent = true;
  mocks.notificationActionsConsent = true;
  mocks.clickableConsent = true;
  mocks.liveItems = [{ id: "unread-1", category: "mention" }];
  mocks.receive = undefined;
  mocks.unsubscribe.mockReset();
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.navigate.mockReset();
  installBridge();
});

afterEach(() => {
  Reflect.deleteProperty(window, "electronAPI");
});

describe("useOverlayNotificationActions", () => {
  it("confirms a current authorized inbox intent before navigating, without marking a row read", async () => {
    const onOpen = (window.electronAPI as never as { onOverlayOpenInbox: ReturnType<typeof vi.fn> }).onOverlayOpenInbox;
    const { result } = renderHook(() => useOverlayNotificationActions(true, true));
    const session = result.current;
    expect(session).toEqual(expect.any(String));
    expect(onOpen).toHaveBeenCalledTimes(1);

    await act(async () => {
      emit(session!);
      await Promise.resolve();
    });

    expect(mocks.confirm).toHaveBeenCalledWith(session);
    expect(mocks.navigate).toHaveBeenCalledWith({ type: "inbox", channelId: "inbox", label: "common:inbox" });
  });

  it("ignores wrong-session events and rejects owner or auth-generation changes", async () => {
    const { result } = renderHook(() => useOverlayNotificationActions(true, true));
    const session = result.current!;
    emit("other-session");
    expect(mocks.confirm).not.toHaveBeenCalled();

    mocks.owner = "other-owner";
    emit(session);
    expect(mocks.confirm).not.toHaveBeenCalled();
    mocks.owner = "owner-1";
    mocks.generation += 1;
    emit(session);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("does not activate without overlay, notification, or clickable-action consent", () => {
    for (const field of ["overlayEnabled", "notificationConsent", "notificationActionsConsent"] as const) {
      mocks[field] = false;
      const onOpen = installBridge();
      const { result, unmount } = renderHook(() => useOverlayNotificationActions(true, true));
      expect(result.current).toBeNull();
      expect(onOpen).not.toHaveBeenCalled();
      unmount();
      mocks[field] = true;
    }
  });

  it("does not treat mute/deafen clickable consent alone as inbox-opening consent", () => {
    mocks.clickableConsent = true;
    mocks.notificationActionsConsent = false;
    const onOpen = installBridge();
    const { result } = renderHook(() => useOverlayNotificationActions(true, true));
    expect(result.current).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("requires currently visible authorized unread items after block or server-access revocation", () => {
    const { result } = renderHook(() => useOverlayNotificationActions(true, true));
    const session = result.current!;
    // Shared live-access projection returns no eligible rows after either
    // a block or a server-membership/access change.
    mocks.liveItems = [];
    emit(session);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("does not register while disconnected, and unmount removes activation ability", () => {
    const onOpen = installBridge();
    const disconnected = renderHook(() => useOverlayNotificationActions(false, true));
    expect(disconnected.result.current).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    disconnected.unmount();

    const active = renderHook(() => useOverlayNotificationActions(true, true));
    const session = active.result.current!;
    const staleCallback = mocks.receive;
    active.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    act(() => staleCallback?.({ session }));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("does not navigate when native confirmation is false, rejects, or access changes while awaiting", async () => {
    const { result } = renderHook(() => useOverlayNotificationActions(true, true));
    const session = result.current!;
    mocks.confirm.mockResolvedValueOnce(false);
    await act(async () => { emit(session); await Promise.resolve(); });
    expect(mocks.navigate).not.toHaveBeenCalled();

    mocks.confirm.mockRejectedValueOnce(new Error("stale intent"));
    await act(async () => { emit(session); await Promise.resolve(); });
    expect(mocks.navigate).not.toHaveBeenCalled();

    let resolve!: (value: boolean) => void;
    mocks.confirm.mockReturnValueOnce(new Promise<boolean>((done) => { resolve = done; }));
    await act(async () => {
      emit(session);
      await Promise.resolve();
      mocks.owner = "switched-account";
      resolve(true);
      await Promise.resolve();
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("serializes repeated activation events while confirmation is pending", async () => {
    let resolve!: (value: boolean) => void;
    mocks.confirm.mockReturnValueOnce(new Promise<boolean>((done) => { resolve = done; }));
    const { result } = renderHook(() => useOverlayNotificationActions(true, true));
    const session = result.current!;

    await act(async () => {
      emit(session);
      emit(session);
      await Promise.resolve();
      expect(mocks.confirm).toHaveBeenCalledTimes(1);
      resolve(true);
      await Promise.resolve();
    });

    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });
});
it("does not open the inbox after compatibility changes across native confirmation",async()=>{let finish!:(value:boolean)=>void;mocks.confirm.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));const view=renderHook(()=>useOverlayNotificationActions(true,true));const old=view.result.current!;act(()=>mocks.receive?.({session:old}));mocks.compatibility=true;await act(async()=>finish(true));expect(mocks.navigate).not.toHaveBeenCalled();view.rerender();expect(view.result.current).toBeNull();mocks.compatibility=false;view.rerender();expect(view.result.current).not.toBe(old);});
