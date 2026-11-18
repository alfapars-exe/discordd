import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { openCachedSearchDeletionPool, type SearchDeletionPool } from "../crypto/cachedSearchDeletionSpool";
import { fakeCachedSearchDeletionPool } from "../test/fakeCachedSearchDeletionPool";
import { useCachedSearchDeletionPool } from "./useCachedSearchDeletionPool";

vi.mock("../crypto/cachedSearchDeletionSpool", () => ({ openCachedSearchDeletionPool: vi.fn() }));
beforeEach(() => vi.mocked(openCachedSearchDeletionPool).mockReset());

it("does not acquire storage for plaintext search", async () => {
  const view = renderHook(() => useCachedSearchDeletionPool(false));
  expect(view.result.current.peek()).toBeNull();
  await expect(view.result.current.get()).rejects.toThrow("scope_unavailable");
  expect(openCachedSearchDeletionPool).not.toHaveBeenCalled();
});

it("shares acquisition and closes a resource that arrives after unmount", async () => {
  let resolve!: (pool: SearchDeletionPool) => void;
  vi.mocked(openCachedSearchDeletionPool).mockReturnValue(new Promise(done => { resolve = done; }));
  const pool = fakeCachedSearchDeletionPool();
  const view = renderHook(() => useCachedSearchDeletionPool(true));
  const pending = view.result.current.get();
  expect(view.result.current.get()).toBe(pending);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  view.unmount();
  await act(async () => resolve(pool));
  await rejected;
  expect(pool.closed).toBe(true);
  expect(openCachedSearchDeletionPool).toHaveBeenCalledTimes(1);
});

it("retries a failed acquisition and retires it when disabled", async () => {
  const pool = fakeCachedSearchDeletionPool();
  vi.mocked(openCachedSearchDeletionPool)
    .mockRejectedValueOnce(new DOMException("quota", "QuotaExceededError"))
    .mockResolvedValueOnce(pool);
  const view = renderHook(({ enabled }) => useCachedSearchDeletionPool(enabled), { initialProps: { enabled: true } });
  await act(async () => {});
  await act(async () => { expect(await view.result.current.get()).toBe(pool); });
  expect(view.result.current.peek()).toBe(pool);
  view.rerender({ enabled: false });
  expect(pool.closed).toBe(true);
  expect(view.result.current.peek()).toBeNull();
  expect(openCachedSearchDeletionPool).toHaveBeenCalledTimes(2);
});
