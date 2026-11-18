import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWebUpdateChecker } from "./useWebUpdateChecker";

vi.mock("../utils/constants", () => ({
  API_BASE_URL: "https://api.test.local/api", SERVER_URL: "https://api.test.local",
  isElectron: () => false, isCapacitor: () => false, isAppProtocolPage: () => false,
}));
const fetchMock = vi.fn();
const response = (version: string) => new Response(JSON.stringify({ success: true, data: { version } }),
  { status: 200, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fetchMock.mockReset().mockImplementation(async () => response("initial"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(["headers", "body"])("real HTTP lifetime releases a stalled %s request and permits redeploy detection", async stage => {
  let signal: AbortSignal | undefined;
  fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    if (stage === "headers") return new Promise<Response>((_, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(),
      json: () => new Promise(() => {}) } as Response);
  });
  const view = renderHook(useWebUpdateChecker);
  try {
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
    expect(signal?.aborted).toBe(true);
    // The polling tick may precede deadline completion in the same event turn.
    // A visibility wakeup must still be admitted once the HTTP lifetime ends.
    if (fetchMock.mock.calls.length === 1) {
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(view.result.current).toBe(false);
    fetchMock.mockImplementationOnce(async () => response("redeployed"));
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(view.result.current).toBe(true);
  } finally { view.unmount(); }
  expect(vi.getTimerCount()).toBe(0);
});
