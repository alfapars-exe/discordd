import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ProfileShowcase } from "../api/profile";

vi.mock("../api/profile", () => ({ getUserProfileShowcase: vi.fn() }));

import { getUserProfileShowcase } from "../api/profile";
import { setTokens } from "../api/client";
import { publishAuthOwnerChange } from "../api/authSessionEvents";
import { useUserProfileShowcase } from "./useUserProfileShowcase";

const mockGet = vi.mocked(getUserProfileShowcase);
type Res = Awaited<ReturnType<typeof getUserProfileShowcase>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function result(version: number): Res {
  return {
    success: true,
    data: {
      version,
      theme: { primary: "#000", secondary: "#fff" },
      widgets: [],
      links: [],
    } as ProfileShowcase,
  } as Res;
}

describe("useUserProfileShowcase", () => {
  beforeEach(() => {
    mockGet.mockReset();
    publishAuthOwnerChange("showcase-owner-a");
    setTokens("test-a", "", "showcase-owner-a");
  });

  it("hides results immediately when the target or server context changes", async () => {
    const targetA = deferred<Res>();
    const targetB = deferred<Res>();
    const newServer = deferred<Res>();
    mockGet.mockReturnValueOnce(targetA.promise).mockReturnValueOnce(targetB.promise).mockReturnValueOnce(newServer.promise);
    const { result: hookResult, rerender } = renderHook(
      ({ userId, serverId }) => useUserProfileShowcase(userId, serverId),
      { initialProps: { userId: "target-a", serverId: "server-a" } },
    );
    rerender({ userId: "target-b", serverId: "server-a" });
    targetB.resolve(result(2));
    await waitFor(() => expect(hookResult.current?.version).toBe(2));

    rerender({ userId: "target-b", serverId: "server-b" });
    expect(hookResult.current).toBeNull();
    targetA.resolve(result(1));
    newServer.resolve(result(3));
    await waitFor(() => expect(hookResult.current?.version).toBe(3));
  });

  it("fences a response and hides the prior account's showcase on account switch", async () => {
    const oldAccount = deferred<Res>();
    const newAccount = deferred<Res>();
    mockGet.mockReturnValueOnce(oldAccount.promise).mockReturnValueOnce(newAccount.promise);
    const { result: hookResult } = renderHook(() => useUserProfileShowcase("target", "server"));

    publishAuthOwnerChange("showcase-owner-b");
    setTokens("test-b", "", "showcase-owner-b");
    expect(hookResult.current).toBeNull();
    oldAccount.resolve(result(1));
    newAccount.resolve(result(2));
    await waitFor(() => expect(hookResult.current?.version).toBe(2));
  });

  it("clears and refetches on a scoped privacy invalidation", async () => {
    mockGet.mockResolvedValueOnce(result(1));
    const { result: hookResult } = renderHook(() => useUserProfileShowcase("target", null));
    await waitFor(() => expect(hookResult.current?.version).toBe(1));

    const after = deferred<Res>();
    mockGet.mockReturnValueOnce(after.promise);
    act(() => window.dispatchEvent(new CustomEvent("hichat:profile-invalidated", { detail: { userId: "target" } })));
    expect(hookResult.current).toBeNull();
    after.resolve(result(2));
    await waitFor(() => expect(hookResult.current?.version).toBe(2));
  });
});
