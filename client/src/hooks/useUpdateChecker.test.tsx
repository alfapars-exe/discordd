import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUpdateChecker } from "./useUpdateChecker";

vi.mock("../utils/constants", () => ({ isElectron: () => true }));

afterEach(() => { delete window.electronAPI; vi.useRealTimers(); });

it("StrictMode remount owns four listeners and unmount clears its snooze timer", () => {
  vi.useFakeTimers();
  const available = new Set<(info: { version: string }) => void>();
  const downloaded = new Set<(info: { version: string }) => void>();
  const progress = new Set<(info: { percent: number }) => void>();
  const error = new Set<(message: string) => void>();
  const subscribe = <T,>(set: Set<T>, callback: T) => { set.add(callback); return () => { set.delete(callback); }; };
  window.electronAPI = {
    onUpdateAvailable: (callback) => subscribe(available, callback),
    onUpdateDownloaded: (callback) => subscribe(downloaded, callback),
    onUpdateProgress: (callback) => subscribe(progress, callback),
    onUpdateError: (callback) => subscribe(error, callback),
  } as NonNullable<Window["electronAPI"]>;
  const view = renderHook(useUpdateChecker, { wrapper: StrictMode });
  expect([available.size, downloaded.size, progress.size, error.size]).toEqual([1, 1, 1, 1]);
  act(() => downloaded.forEach((callback) => callback({ version: "test-version" })));
  expect(view.result.current.status).toBe("ready");
  act(() => view.result.current.dismiss());
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect([available.size, downloaded.size, progress.size, error.size]).toEqual([0, 0, 0, 0]);
  expect(vi.getTimerCount()).toBe(0);
});
