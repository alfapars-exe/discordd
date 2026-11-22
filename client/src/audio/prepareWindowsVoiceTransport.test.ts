import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ electron: true }));
vi.mock("../utils/constants", () => ({ isElectron: () => platform.electron }));
const deferred = () => {
  let resolve!: (value: { supported: boolean }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ supported: boolean }>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let query: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); platform.electron = true;
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
  query = vi.fn().mockResolvedValue({ supported: true });
  vi.stubGlobal("VideoEncoder", { isConfigSupported: query });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([true, false])("releases readiness after capability discovery regardless of support=%s", async supported => {
  const pending = deferred(); query.mockReturnValue(pending.promise);
  const preparation = await import("./prepareWindowsVoiceTransport");
  const changed = vi.fn(); const unsubscribe = preparation.subscribeWindowsVoiceTransport(changed);
  const result = preparation.prepareWindowsVoiceTransport();
  expect(preparation.windowsVoiceTransportReady()).toBe(false);
  expect(query).toHaveBeenCalledExactlyOnceWith({ codec: "avc1.42001E", width: 640, height: 480, hardwareAcceleration: "prefer-hardware" });
  pending.resolve({ supported }); await result;
  expect(preparation.windowsVoiceTransportReady()).toBe(true);
  expect(changed).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  unsubscribe();
});

it("shares one pending operation and never repeats discovery after completion", async () => {
  const pending = deferred(); query.mockReturnValue(pending.promise);
  const { prepareWindowsVoiceTransport } = await import("./prepareWindowsVoiceTransport");
  const first = prepareWindowsVoiceTransport();
  expect(prepareWindowsVoiceTransport()).toBe(first);
  pending.resolve({ supported: true }); await first;
  expect(prepareWindowsVoiceTransport()).toBe(first);
  expect(query).toHaveBeenCalledOnce();
});

it.each(["reject", "throw"])("falls back to ordinary connection when the capability query fails by %s", async mode => {
  if (mode === "reject") query.mockRejectedValue(new Error("GPU query failed"));
  else query.mockImplementation(() => { throw new Error("GPU query failed"); });
  const preparation = await import("./prepareWindowsVoiceTransport");
  await expect(preparation.prepareWindowsVoiceTransport()).resolves.toBeUndefined();
  expect(preparation.windowsVoiceTransportReady()).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["resolve", "reject"])("bounds a hung query and ignores its late %s", async late => {
  const pending = deferred(); query.mockReturnValue(pending.promise);
  const preparation = await import("./prepareWindowsVoiceTransport");
  const changed = vi.fn(); preparation.subscribeWindowsVoiceTransport(changed);
  const result = preparation.prepareWindowsVoiceTransport();
  await vi.advanceTimersByTimeAsync(preparation.VOICE_TRANSPORT_PREPARATION_TIMEOUT_MS);
  await result;
  expect(preparation.windowsVoiceTransportReady()).toBe(true); expect(changed).toHaveBeenCalledOnce();
  if (late === "resolve") pending.resolve({ supported: true }); else pending.reject(new Error("late failure"));
  await Promise.resolve();
  expect(changed).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it.each(["web", "mac", "linux", "missing-api", "missing-method"])("does no preparation for %s", async mode => {
  if (mode === "web") platform.electron = false;
  if (mode === "mac" || mode === "linux") vi.stubGlobal("navigator", { userAgent: mode });
  if (mode === "missing-api") vi.stubGlobal("VideoEncoder", undefined);
  if (mode === "missing-method") vi.stubGlobal("VideoEncoder", {});
  const preparation = await import("./prepareWindowsVoiceTransport");
  expect(preparation.windowsVoiceTransportReady()).toBe(true);
  await preparation.prepareWindowsVoiceTransport();
  expect(query).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("keeps immediate admission pending without blocking other tasks, then updates the live hook", async () => {
  const pending = deferred(); query.mockReturnValue(pending.promise);
  const { useVoiceTransportReady } = await import("../hooks/useVoiceTransportReady");
  const view = renderHook(useVoiceTransportReady, { wrapper: StrictMode });
  expect(view.result.current).toBe(false); expect(query).toHaveBeenCalledOnce();
  let inputHandled = false; queueMicrotask(() => { inputHandled = true; });
  await act(async () => { await Promise.resolve(); });
  expect(inputHandled).toBe(true); expect(view.result.current).toBe(false);
  await act(async () => { pending.resolve({ supported: true }); await Promise.resolve(); });
  expect(view.result.current).toBe(true); view.unmount();
});

it("does not revive an unmounted gate, while a replacement hook can use the same preparation", async () => {
  const pending = deferred(); query.mockReturnValue(pending.promise);
  const { useVoiceTransportReady } = await import("../hooks/useVoiceTransportReady");
  const retiredRender = vi.fn();
  const retired = renderHook(() => { retiredRender(); return useVoiceTransportReady(); });
  expect(retired.result.current).toBe(false); retired.unmount(); const renders = retiredRender.mock.calls.length;
  const current = renderHook(useVoiceTransportReady);
  await act(async () => { pending.resolve({ supported: true }); await Promise.resolve(); });
  expect(retiredRender).toHaveBeenCalledTimes(renders);
  expect(current.result.current).toBe(true); expect(query).toHaveBeenCalledOnce(); current.unmount();
});
