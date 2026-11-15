import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWebUpdateChecker } from "./useWebUpdateChecker";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../api/client", () => ({ apiClient: request }));
let visibility: "visible" | "hidden";
beforeEach(() => {
  vi.useFakeTimers(); visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  request.mockReset().mockResolvedValue({ success: true, data: { version: "initial" } });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const changeVisibility = (state: typeof visibility) => act(() => {
  visibility = state; document.dispatchEvent(new Event("visibilitychange"));
});

it("does not poll an initially hidden tab and clears a pending tick when hidden", async () => {
  visibility = "hidden";
  const view = renderHook(useWebUpdateChecker);
  try {
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    changeVisibility("visible");
    await act(async () => { await Promise.resolve(); });
    expect(request).toHaveBeenCalledTimes(1);
    changeVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(request).toHaveBeenCalledTimes(1);
  } finally { view.unmount(); }
});

it("owns at most one request across visibility bursts and slow polling", async () => {
  let complete!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const view = renderHook(useWebUpdateChecker);
  try {
    changeVisibility("visible"); changeVisibility("visible");
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => { complete({ success: true, data: { version: "initial" } }); });
    request.mockResolvedValueOnce({ success: true, data: { version: "redeployed" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(view.result.current).toBe(true);
  } finally { view.unmount(); }
});

it("aborts its owned request on unmount and ignores a late response", async () => {
  let complete!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const view = renderHook(useWebUpdateChecker);
  const signal = request.mock.calls[0][1]?.signal as AbortSignal | undefined;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { complete({ success: true, data: { version: "late" } }); });
  changeVisibility("visible");
  expect(request).toHaveBeenCalledTimes(1);
});
