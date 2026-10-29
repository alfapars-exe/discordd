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
  it("retries uncertain errors only with durable idempotency",async()=>{
    const send=vi.fn().mockResolvedValueOnce(netErr()).mockResolvedValueOnce(ok({id:"one"}));
    const result=sendWithRetryAndToast(send,{idempotent:true});await vi.runAllTimersAsync();expect((await result).success).toBe(true);expect(send).toHaveBeenCalledTimes(2);expect(addToast).not.toHaveBeenCalled();
  });
  it("does not dispatch or toast after its caller context is abandoned",async()=>{
    const send=vi.fn().mockResolvedValue(ok());const result=await sendWithRetryAndToast(send,{isCurrent:()=>false});expect(result.success).toBe(false);expect(send).not.toHaveBeenCalled();expect(addToast).not.toHaveBeenCalled();
  });
  it("does not toast a late failure into a replacement context",async()=>{
    let current=true,finish!:(value:APIResponse<unknown>)=>void;const sending=sendWithRetryAndToast(()=>new Promise<APIResponse<unknown>>(resolve=>{finish=resolve}),{isCurrent:()=>current});current=false;finish(netErr());expect((await sending).success).toBe(false);expect(addToast).not.toHaveBeenCalled();
  });
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

  it("does not replay a network failure even if another attempt would succeed", async () => {
    const send = vi
      .fn<() => Promise<APIResponse<{ id: string }>>>()
      .mockResolvedValueOnce(netErr())
      .mockResolvedValueOnce(ok({ id: "m-1" }));
    const promise = sendWithRetryAndToast(send);
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.success).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith("error", "chat:sendFailed");
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

  it.each([502,503,504])("does not replay an ambiguous gateway response %s", async (status) => {
    const send = vi
      .fn<() => Promise<APIResponse<{ id: string }>>>()
      .mockResolvedValueOnce({ success: false, error: `service_unavailable: HTTP ${status}`, status })
      .mockResolvedValueOnce(ok({ id: "m-1" }));
    const promise = sendWithRetryAndToast(send);
    await vi.runAllTimersAsync();
    const res = await promise;
    expect(res.success).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith("error", "chat:sendFailed");
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

  it("shows a single error toast after a network failure", async () => {
    const send = vi.fn().mockResolvedValue(netErr());
    const promise = sendWithRetryAndToast(send);
    await vi.runAllTimersAsync();
    await promise;
    expect(send).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast.mock.calls[0]![0]).toBe("error");
    expect(addToast.mock.calls[0]![1]).toBe("chat:sendFailed");
  });

  it("does not schedule a delayed duplicate after a network failure", async () => {
    const send = vi
      .fn<() => Promise<APIResponse<unknown>>>()
      .mockResolvedValueOnce(netErr())
      .mockResolvedValueOnce(ok());
    const promise = sendWithRetryAndToast(send);

    // First call fires immediately.
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);

    // Advancing timers must not replay an ambiguous write.
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledTimes(1);

    // No delayed retry after the historical retry interval either.
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("suppresses toast when caller passes silent=true", async () => {
    const send = vi.fn().mockResolvedValue(netErr());
    const promise = sendWithRetryAndToast(send, { silent: true });
    await vi.runAllTimersAsync();
    await promise;
    expect(addToast).not.toHaveBeenCalled();
  });
});
