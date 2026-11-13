import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUpdateChecker } from "./useUpdateChecker";

vi.mock("../utils/constants", () => ({ isElectron: () => true }));

afterEach(() => { delete window.electronAPI; vi.useRealTimers(); });

function updaterHarness(strict = false) {
  vi.useFakeTimers();
  const available = new Set<(info: { version: string }) => void>();
  const downloaded = new Set<(info: { version: string }) => void>();
  const progress = new Set<(info: { percent: number }) => void>();
  const error = new Set<(message: string) => void>();
  const subscribe = <T,>(set: Set<T>, callback: T) => { set.add(callback); return () => { set.delete(callback); }; };
  window.electronAPI = {
    onUpdateAvailable: callback => subscribe(available, callback),
    onUpdateDownloaded: callback => subscribe(downloaded, callback),
    onUpdateProgress: callback => subscribe(progress, callback),
    onUpdateError: callback => subscribe(error, callback),
  } as NonNullable<Window["electronAPI"]>;
  const view = renderHook(useUpdateChecker, strict ? { wrapper: StrictMode } : undefined);
  return {
    view,
    listenerCounts: () => [available.size, downloaded.size, progress.size, error.size],
    available: (version: string) => act(() => available.forEach(callback => callback({ version }))),
    downloaded: (version: string) => act(() => downloaded.forEach(callback => callback({ version }))),
    progress: (percent: number) => act(() => progress.forEach(callback => callback({ percent }))),
    error: () => act(() => error.forEach(callback => callback("offline"))),
  };
}

it.each([false, true])("retains a completed installer through later check/progress/error events (snoozed=%s)", snoozed => {
  const h = updaterHarness(); h.downloaded("2.0.0");
  if (snoozed) act(() => h.view.result.current.dismiss());
  h.available("2.0.0"); h.progress(12); h.error();
  expect(h.view.result.current.status).toBe(snoozed ? "idle" : "ready");
  expect(h.view.result.current.update).toEqual({ version: "2.0.0" });
  expect(h.view.result.current.progress).toBe(100);
  if (snoozed) {
    act(() => vi.advanceTimersByTime(30 * 60 * 1000));
    expect(h.view.result.current.status).toBe("ready");
  }
  h.view.unmount();
});

it("does not cancel snooze when the same downloaded event is delivered again", () => {
  const h = updaterHarness(); h.downloaded("2.0.0");
  act(() => h.view.result.current.dismiss());
  h.downloaded("2.0.0");
  expect(h.view.result.current.status).toBe("idle");
  expect(vi.getTimerCount()).toBe(1);
  h.view.unmount();
});

it("replaces the ready installer only after the new download completes and retires its old snooze", () => {
  const h = updaterHarness(); h.downloaded("2.0.0");
  act(() => h.view.result.current.dismiss());
  h.downloaded("3.0.0");
  expect(h.view.result.current.status).toBe("ready");
  expect(h.view.result.current.update).toEqual({ version: "3.0.0" });
  expect(vi.getTimerCount()).toBe(0);
  h.view.unmount();
});

it("clears a failed incomplete download and accepts a successful retry", () => {
  const h = updaterHarness(); h.available("2.0.0"); h.progress(42); h.error();
  expect(h.view.result.current.status).toBe("idle");
  expect(h.view.result.current.update).toBeNull();
  h.available("2.0.0"); h.progress(65); h.downloaded("2.0.0");
  expect(h.view.result.current.status).toBe("ready");
  expect(h.view.result.current.progress).toBe(100);
  h.view.unmount();
});

it("lets a different available version own the new download and clears an obsolete ready snooze", () => {
  const h = updaterHarness(); h.downloaded("2.0.0");
  act(() => h.view.result.current.dismiss());
  h.available("3.0.0"); h.progress(42);
  expect(h.view.result.current.status).toBe("downloading");
  expect(h.view.result.current.update).toEqual({ version: "3.0.0" });
  expect(vi.getTimerCount()).toBe(0);
  h.error();
  expect(h.view.result.current.status).toBe("idle");
  expect(h.view.result.current.update).toBeNull();
  h.available("3.0.0"); h.downloaded("3.0.0");
  expect(h.view.result.current.status).toBe("ready");
  expect(h.view.result.current.update).toEqual({ version: "3.0.0" });
  h.view.unmount();
});

it("StrictMode remount owns four listeners and unmount clears its snooze timer", () => {
  const h = updaterHarness(true);
  expect(h.listenerCounts()).toEqual([1, 1, 1, 1]);
  h.downloaded("test-version");
  expect(h.view.result.current.status).toBe("ready");
  act(() => h.view.result.current.dismiss());
  expect(vi.getTimerCount()).toBe(1);
  h.view.unmount();
  expect(h.listenerCounts()).toEqual([0, 0, 0, 0]);
  expect(vi.getTimerCount()).toBe(0);
});
