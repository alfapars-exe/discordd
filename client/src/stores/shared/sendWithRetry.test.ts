import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { APIResponse } from "../../types";

const addToast = vi.fn();
vi.mock("../toastStore", () => ({
  useToastStore: { getState: () => ({ addToast }) },
}));

vi.mock("../../i18n", () => ({
  default: { t: (key: string) => key },
}));

import { sendWithRetryAndToast } from "./sendWithRetry";

function ok<T>(data?: T): APIResponse<T> {
  return { success: true, data };
}
function netErr<T>(): APIResponse<T> {
  return { success: false, error: "Network request failed", isNetworkError: true };
}
function httpErr<T>(status: number, error: string): APIResponse<T> {
  return { success: false, error, status };
}

describe("sendWithRetryAndToast", () => {
  beforeEach(() => {
    addToast.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the response on first-attempt success", async () => {
    const send = vi.fn().mockResolvedValue(ok({ id: "m-1" }));
    const promise = sendWithRetryAndToast(send);
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(addToast).not.toHaveBeenCalled();
  });

  it("retries once on network error and returns success if the retry succeeds", async () => {
    const send = vi
      .fn<() => Promise<APIResponse<{ id: string }>>>()
      .mockResolvedValueOnce(netErr())
      .mockResolvedValueOnce(ok({ id: "m-1" }));
    const promise = sendWithRetryAndToast(send);
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(addToast).not.toHaveBeenCalled();
  });

  it("does NOT retry on a deterministic 4xx", async () => {
    const send = vi.fn().mockResolvedValue(httpErr(400, "bad request"));
    const promise = sendWithRetryAndToast(send);
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.success).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0]![0]).toBe("error");
  });

  it("surfaces 429 as a rate-limit warning toast (not error) with i18n key", async () => {
    const send = vi.fn().mockResolvedValue(httpErr(429, "too many requests"));
    const promise = sendWithRetryAndToast(send);
    await vi.runAllTimersAsync();
    await promise;
    expect(addToast).toHaveBeenCalledTimes(1);
    const [type, message] = addToast.mock.calls[0]!;
    expect(type).toBe("warning");
    expect(message).toBe("chat:tooManyMessages");
  });

  it("also recognizes 429 signaled only in the error text (server variant)", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ success: false, error: "too many messages, wait 15s" } as APIResponse<unknown>);
    const promise = sendWithRetryAndToast(send);
    await vi.runAllTimersAsync();
    await promise;
    expect(addToast).toHaveBeenCalledWith("warning", "chat:tooManyMessages");
  });

  it("retries once on the HF cold-boot sentinel (502/503/504 → service_unavailable:)", async () => {
    const send = vi
      .fn<() => Promise<APIResponse<{ id: string }>>>()
      .mockResolvedValueOnce({ success: false, error: "service_unavailable: HTTP 503", status: 503 })
      .mockResolvedValueOnce(ok({ id: "m-1" }));
    const promise = sendWithRetryAndToast(send);
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(addToast).not.toHaveBeenCalled();
  });

  it("does NOT retry a timed-out send (duplicate risk without idempotency keys)", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ success: false, error: "timeout", isTimeout: true } as APIResponse<unknown>);
    const promise = sendWithRetryAndToast(send);
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.success).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0]![0]).toBe("error");
  });

  it("shows a generic error toast when both attempts fail with network error", async () => {
    const send = vi.fn().mockResolvedValue(netErr());
    const promise = sendWithRetryAndToast(send);
    await vi.runAllTimersAsync();
    await promise;
    expect(send).toHaveBeenCalledTimes(2);
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0]![0]).toBe("error");
    expect(addToast.mock.calls[0]![1]).toBe("chat:sendFailed");
  });

  it("waits the retry delay between attempts (no back-to-back hammer)", async () => {
    const send = vi
      .fn<() => Promise<APIResponse<unknown>>>()
      .mockResolvedValueOnce(netErr())
      .mockResolvedValueOnce(ok());
    const promise = sendWithRetryAndToast(send);

    // First call fires immediately.
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);

    // Nothing yet — retry is scheduled for ~1.5s later.
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(1);

    // Past the delay, retry fires.
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("suppresses toast when caller passes silent=true", async () => {
    const send = vi.fn().mockResolvedValue(netErr());
    const promise = sendWithRetryAndToast(send, { silent: true });
    await vi.runAllTimersAsync();
    await promise;
    expect(addToast).not.toHaveBeenCalled();
  });
});
